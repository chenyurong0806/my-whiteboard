// App.jsx
import React, { useState, useEffect, useRef } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { createClient } from "@supabase/supabase-js";

// ---------------- Supabase 配置 ----------------
const SUPABASE_URL = "https://mamubvgmcetepllznifl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HEeNPSqD75cWlnmZjcVHKA_Pw-OdL_A";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------- 注入平滑过渡动画 ----------------
const injectCSS = () => {
  if (document.getElementById("excalidraw-custom-styles")) return;
  const style = document.createElement("style");
  style.id = "excalidraw-custom-styles";
  style.innerHTML = `
    .sidebar-transition {
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .hide-scrollbar::-webkit-scrollbar {
      display: none;
    }
  `;
  document.head.appendChild(style);
};

export default function App() {
  // ---------------- 状态管理 ----------------
  const [userInfo, setUserInfo] = useState({ id: "", name: "访客", isLoggedIn: false });
  const [publicBoards, setPublicBoards] = useState([]);
  const [privateBoards, setPrivateBoards] = useState([]);
  const [currentBoard, setCurrentBoard] = useState(null);
  const [onlineUsers, setOnlineUsers] = useState(new Map());
  const [isSaving, setIsSaving] = useState(false);
  
  // 核心 UI 状态
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // 引用
  const excalidrawAPIRef = useRef(null);
  const saveTimer = useRef(null);
  const broadcastTimer = useRef(null);
  const lastElementsRef = useRef("[]"); // 用于比对，防止 WebSocket 广播无限循环死锁
  const channelRef = useRef(null);

  useEffect(() => { injectCSS(); }, []);

  // ---------------- 1. 初始化用户 ----------------
  useEffect(() => {
    const initUser = async () => {
      const randomId = Math.random().toString(36).substring(2, 10);
      try {
        const res = await fetch("/api/userinfo");
        if (res.ok) {
          const data = await res.json();
          setUserInfo({ id: randomId, name: data.username, isLoggedIn: true });
        } else throw new Error();
      } catch {
        setUserInfo({ id: randomId, name: `访客_${Math.floor(Math.random() * 1000)}`, isLoggedIn: false });
      }
      await fetchBoards();
    };
    initUser();
  }, []);

  // ---------------- 2. 获取白板列表 ----------------
  const fetchBoards = async () => {
    const { data, error } = await supabase
      .from("whiteboards")
      .select("*")
      .order("updated_at", { ascending: false });

    if (error) return console.error("获取白板失败:", error);

    const publicList = data.filter(b => b.is_public);
    const privateList = data.filter(b => b.owner === userInfo.name && !b.is_public);

    setPublicBoards(publicList);
    setPrivateBoards(privateList);

    if (!currentBoard) {
      if (privateList.length > 0) setCurrentBoard(privateList[0]);
      else if (publicList.length > 0) setCurrentBoard(publicList[0]);
    }
  };

  // ---------------- 3. 核心：WebSocket 实时同步 (Broadcast + Presence) ----------------
  useEffect(() => {
    if (!currentBoard?.id || !userInfo.id) return;

    // 清理之前的频道
    if (channelRef.current) supabase.removeChannel(channelRef.current);

    const channel = supabase.channel(`board_${currentBoard.id}`, {
      config: { presence: { key: userInfo.id } }
    });
    channelRef.current = channel;

    channel
      // A. 监听在线人数和光标 (Presence)
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        const users = new Map();
        const collaborators = new Map();

        Object.keys(state).forEach(id => {
          const userState = state[id][0];
          users.set(id, userState);
          // 排除自己，渲染别人的光标
          if (id !== userInfo.id && userState.pointer) {
            collaborators.set(id, {
              pointer: userState.pointer,
              button: userState.button || "up",
              username: userState.name,
              selectedElementIds: userState.selectedElementIds || {}
            });
          }
        });
        setOnlineUsers(users);
        if (excalidrawAPIRef.current) {
          excalidrawAPIRef.current.updateScene({ collaborators });
        }
      })
      // B. 监听别人画画的实时广播 (Broadcast)
      .on("broadcast", { event: "canvas_update" }, ({ payload }) => {
        if (payload.userId === userInfo.id || !excalidrawAPIRef.current) return;
        
        // 标记远端数据，防止触发本地 onChange 形成死循环
        lastElementsRef.current = JSON.stringify(payload.elements);
        
        excalidrawAPIRef.current.updateScene({ 
          elements: payload.elements,
          commitToHistory: false // 不污染本地撤销历史
        });
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ name: userInfo.name, pointer: null });
        }
      });

    // 切换房间时，从数据库加载当前画板快照
    loadBoardToCanvas(currentBoard);

    return () => { supabase.removeChannel(channel); };
  }, [currentBoard?.id, userInfo.id]);

  // 加载数据到画布
  const loadBoardToCanvas = (board) => {
    if (!excalidrawAPIRef.current || !board) return;
    let elements = [];
    try {
      // 兼容 jsonb 数组或字符串
      elements = typeof board.content === "string" ? JSON.parse(board.content) : board.content || [];
    } catch { elements = []; }
    
    lastElementsRef.current = JSON.stringify(elements);
    excalidrawAPIRef.current.updateScene({ elements });
  };

  // ---------------- 4. 触发更新 (节流广播 + 防抖保存) ----------------
  const handleOnChange = (elements) => {
    if (!currentBoard) return;
    const elementsStr = JSON.stringify(elements);
    
    // 如果跟上次记录的一样（或者是由远端 updateScene 触发的），则忽略
    if (elementsStr === lastElementsRef.current) return;
    lastElementsRef.current = elementsStr;

    // 【高频】WebSocket 广播给其他在线用户 (每 50ms 节流)
    if (channelRef.current) {
      clearTimeout(broadcastTimer.current);
      broadcastTimer.current = setTimeout(() => {
        channelRef.current.send({
          type: "broadcast",
          event: "canvas_update",
          payload: { userId: userInfo.id, elements }
        });
      }, 50);
    }

    // 【低频】数据库持久化保存 (停止作画 1.5秒 后防抖保存)
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setIsSaving(true);
      await supabase
        .from("whiteboards")
        .update({ content: elements, updated_at: new Date().toISOString() })
        .eq("id", currentBoard.id);
      setIsSaving(false);
    }, 1500);
  };

  // 鼠标移动时更新光标位置
  const handlePointerUpdate = (payload) => {
    if (channelRef.current) {
      channelRef.current.track({
        name: userInfo.name,
        pointer: payload.pointer,
        button: payload.button,
        selectedElementIds: payload.selectedElementIds
      });
    }
  };

  // ---------------- 5. 业务操作 ----------------
  const handleCreateBoard = async () => {
    if (!userInfo.isLoggedIn) return alert("请先登录");
    const title = prompt("请输入新白板名称");
    if (!title) return;
    const { data } = await supabase
      .from("whiteboards")
      .insert([{ title, owner: userInfo.name, content: [], is_public: false }])
      .select()
      .single();
    
    setPrivateBoards(prev => [data, ...prev]);
    setCurrentBoard(data);
  };

  const handleTogglePublish = async (board, e) => {
    e.stopPropagation();
    if (!userInfo.isLoggedIn || board.owner !== userInfo.name) return alert("无权操作");
    const { data } = await supabase
      .from("whiteboards")
      .update({ is_public: !board.is_public })
      .eq("id", board.id)
      .select()
      .single();
      
    await fetchBoards();
    if (currentBoard?.id === board.id) setCurrentBoard(data);
  };

  const handleDeleteBoard = async (board, e) => {
    e.stopPropagation();
    if (board.owner !== userInfo.name) return alert("只能删除自己的白板");
    if (!window.confirm("确定删除该白板吗？")) return;
    await supabase.from("whiteboards").delete().eq("id", board.id);
    if (currentBoard?.id === board.id) setCurrentBoard(null);
    await fetchBoards();
  };

  // ---------------- UI ----------------
  // 动态计算样式以实现完美的收起全屏效果
  const layoutStyles = {
    container: { 
      display: "flex", 
      height: "100vh", 
      width: "100vw",
      backgroundColor: "#f0f2f5", 
      // 收起时去除 padding，让画布顶天立地
      padding: isSidebarOpen ? "12px" : "0px", 
      gap: isSidebarOpen ? "12px" : "0px", 
      boxSizing: "border-box", 
      fontFamily: "sans-serif",
      overflow: "hidden"
    },
    sidebar: { 
      width: isSidebarOpen ? "280px" : "0px", 
      opacity: isSidebarOpen ? 1 : 0,
      padding: isSidebarOpen ? "20px 16px" : "0px",
      background: "#ffffff", 
      borderRadius: "16px", 
      display: "flex", 
      flexDirection: "column", 
      boxShadow: "0 2px 6px rgba(0,0,0,0.05)", 
      overflow: "hidden",
      whiteSpace: "nowrap" // 防止收起时文字换行导致的闪烁
    },
    main: { 
      flex: 1, 
      borderRadius: isSidebarOpen ? "16px" : "0px", 
      background: "#ffffff", 
      display: "flex", 
      flexDirection: "column", 
      overflow: "hidden", 
      position: "relative",
      boxShadow: isSidebarOpen ? "0 2px 10px rgba(0,0,0,0.08)" : "none" 
    }
  };

  return (
    <div className="sidebar-transition" style={layoutStyles.container}>
      
      {/* 侧边栏 */}
      <div className="sidebar-transition" style={layoutStyles.sidebar}>
        <div style={styles.userInfoCard}>
          <div style={styles.avatar}>{userInfo.name.charAt(0)}</div>
          <div>
            <div style={styles.userName}>{userInfo.name}</div>
            <div style={{...styles.userStatus, color: userInfo.isLoggedIn ? "#34A853" : "#9AA0A6"}}>
              ● {userInfo.isLoggedIn ? "已登录" : "访客模式"}
            </div>
          </div>
        </div>

        <div className="hide-scrollbar" style={styles.scrollArea}>
          <div style={styles.sectionTitle}>
            我的私密 
            {userInfo.isLoggedIn && <button onClick={handleCreateBoard} style={styles.fabBtn}>+</button>}
          </div>
          {privateBoards.map(board => (
            <div key={board.id} onClick={() => setCurrentBoard(board)} style={{...styles.roomItem, borderColor: currentBoard?.id === board.id ? "#1a73e8" : "#dadce0"}}>
              <span style={styles.truncate}>{board.title}</span>
              <div style={styles.actions}>
                <button onClick={(e) => handleTogglePublish(board, e)} style={styles.textBtn}>公开</button>
                <button onClick={(e) => handleDeleteBoard(board, e)} style={{...styles.textBtn, color: "#d93025"}}>删</button>
              </div>
            </div>
          ))}

          <div style={{ ...styles.sectionTitle, marginTop: "24px" }}>公共大厅</div>
          {publicBoards.map(board => (
            <div key={board.id} onClick={() => setCurrentBoard(board)} style={{...styles.roomItem, borderColor: currentBoard?.id === board.id ? "#34a853" : "#dadce0"}}>
              <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <span style={styles.truncate}>{board.title}</span>
                <span style={styles.ownerTag}>by {board.owner}</span>
              </div>
              <div style={styles.actions}>
                {board.owner === userInfo.name && (
                  <>
                    <button onClick={(e) => handleTogglePublish(board, e)} style={{...styles.textBtn, color: "#f29900"}}>私有</button>
                    <button onClick={(e) => handleDeleteBoard(board, e)} style={{...styles.textBtn, color: "#d93025"}}>删</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        <div style={styles.onlineBadge}>
          <div style={styles.pulseDot}></div> 房间在线: {onlineUsers.size}
        </div>
      </div>

      {/* 主画布区域 */}
      <div className="sidebar-transition" style={layoutStyles.main}>
        
        {/* 悬浮控制面板 (替代原先的 topBar，让画布更沉浸) */}
        <div style={{ position: "absolute", top: 16, left: 16, zIndex: 10, display: "flex", gap: "12px", alignItems: "center" }}>
          {/* 侧边栏折叠按钮 */}
          <button 
            onClick={() => setIsSidebarOpen(!isSidebarOpen)} 
            style={styles.toggleSidebarBtn}
            title={isSidebarOpen ? "收起侧边栏" : "展开侧边栏"}
          >
            {isSidebarOpen ? "◀" : "▶"}
          </button>
          
          <div style={styles.floatingTitleCard}>
            <span style={{ fontWeight: 600 }}>{currentBoard?.title || "未选择白板"}</span>
            {currentBoard && <span style={styles.tag}>{currentBoard.is_public ? "公共" : "私密"}</span>}
            <span style={{ fontSize: "12px", marginLeft: "8px", color: isSaving ? "#f29900" : "#34a853" }}>
              {isSaving ? "云同步中..." : "已保存"}
            </span>
          </div>
        </div>

        <div style={{ flex: 1, position: "relative" }}>
          <Excalidraw
            excalidrawAPI={(api) => { excalidrawAPIRef.current = api; }}
            onChange={handleOnChange}
            onPointerUpdate={handlePointerUpdate} // 启用光标同步
            theme="light"
            UIOptions={{ canvasActions: { toggleTheme: true } }}
          />
        </div>
      </div>

    </div>
  );
}

// ---------------- 基础样式字典 ----------------
const styles = {
  userInfoCard: { display: "flex", gap: "12px", alignItems: "center", marginBottom: "20px", paddingBottom: "16px", borderBottom: "1px solid #e8eaed" },
  avatar: { width: "40px", height: "40px", borderRadius: "50%", backgroundColor: "#1a73e8", color: "#fff", display: "flex", justifyContent: "center", alignItems: "center", fontSize: "16px", fontWeight: "bold" },
  userName: { fontWeight: "600", color: "#202124", fontSize: "14px" },
  userStatus: { fontSize: "12px", marginTop: "4px", fontWeight: 500 },
  scrollArea: { flex: 1, overflowY: "auto" },
  sectionTitle: { display: "flex", justifyContent: "space-between", alignItems: "center", fontWeight: "700", color: "#5f6368", fontSize: "12px", marginBottom: "12px" },
  roomItem: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px", borderRadius: "8px", cursor: "pointer", background: "#fff", marginBottom: "8px", border: "1px solid transparent", transition: "border 0.2s" },
  truncate: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: "13px", color: "#3c4043", fontWeight: "500", maxWidth: "100px" },
  ownerTag: { fontSize: "11px", color: "#80868b", marginTop: "2px" },
  actions: { display: "flex", gap: "2px" },
  fabBtn: { borderRadius: "50%", width: "24px", height: "24px", border: "none", background: "#1a73e8", color: "#fff", cursor: "pointer", fontSize: "16px", display: "flex", alignItems: "center", justifyContent: "center" },
  textBtn: { fontSize: "11px", padding: "4px", borderRadius: "4px", border: "none", background: "transparent", color: "#1a73e8", cursor: "pointer", fontWeight: "600" },
  onlineBadge: { marginTop: "16px", padding: "10px", background: "#e6f4ea", borderRadius: "8px", fontSize: "12px", color: "#137333", display: "flex", alignItems: "center", gap: "8px", fontWeight: "600" },
  pulseDot: { width: "8px", height: "8px", backgroundColor: "#34A853", borderRadius: "50%" },
  
  // 悬浮面板样式
  toggleSidebarBtn: { width: "40px", height: "40px", borderRadius: "8px", border: "none", background: "#ffffff", color: "#5f6368", cursor: "pointer", boxShadow: "0 2px 6px rgba(0,0,0,0.15)", display: "flex", justifyContent: "center", alignItems: "center", fontSize: "14px" },
  floatingTitleCard: { display: "flex", alignItems: "center", gap: "8px", padding: "0 16px", height: "40px", background: "#ffffff", borderRadius: "8px", boxShadow: "0 2px 6px rgba(0,0,0,0.15)", fontSize: "14px", color: "#202124" },
  tag: { fontSize: "10px", padding: "2px 6px", background: "#e8f0fe", color: "#1a73e8", borderRadius: "4px", fontWeight: "600" }
};