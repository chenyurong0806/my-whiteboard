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

// ---------------- 轻量级 CRDT-lite 合并算法 ----------------
const mergeElements = (localElements, remoteElements) => {
  const remoteMap = new Map(remoteElements.map(el => [el.id, el]));
  const localMap = new Map(localElements.map(el => [el.id, el]));
  
  // 更新本地已有的元素（若远端版本更新）
  const updatedLocal = localElements.map(localEl => {
    const remoteEl = remoteMap.get(localEl.id);
    if (!remoteEl) return localEl;
    // 比较 Excalidraw 的内部版本控制属性
    if (remoteEl.version > localEl.version || (remoteEl.version === localEl.version && remoteEl.versionNonce > localEl.versionNonce)) {
      return remoteEl;
    }
    return localEl;
  });
  
  // 追加本地没有的全新远端元素
  const newRemote = remoteElements.filter(remoteEl => !localMap.has(remoteEl.id));
  
  return [...updatedLocal, ...newRemote];
};

export default function App() {
  // ---------------- 状态管理 ----------------
  const [userInfo, setUserInfo] = useState({ id: "", name: "访客", isLoggedIn: false });
  const [publicBoards, setPublicBoards] = useState([]);
  const [privateBoards, setPrivateBoards] = useState([]);
  const [currentBoard, setCurrentBoard] = useState(null);
  const [onlineUsers, setOnlineUsers] = useState(new Map());
  const [isSaving, setIsSaving] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // ---------------- 核心控制引用 ----------------
  const excalidrawAPIRef = useRef(null);
  const saveTimer = useRef(null);
  const channelRef = useRef(null);
  
  // 同步优化相关的 Ref
  const latestElementsRef = useRef([]);      // 存储最新的本地 elements 镜像
  const isRemoteUpdatingRef = useRef(false);  // 远端更新锁，防止 onChange 回环死锁
  const broadcastThrottlingRef = useRef(false); // 广播节流阀

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

  // ---------------- 3. WebSocket 实时同步 ----------------
  useEffect(() => {
    if (!currentBoard?.id || !userInfo.id) return;

    if (channelRef.current) supabase.removeChannel(channelRef.current);

    const channel = supabase.channel(`board_${currentBoard.id}`, {
      config: { presence: { key: userInfo.id } }
    });
    channelRef.current = channel;

    channel
      // A. 协同光标与选区同步 (Presence)
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        const users = new Map();
        const collaborators = new Map();

        Object.keys(state).forEach(id => {
          const userState = state[id][0];
          users.set(id, userState);
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
      // B. 接收高频画布物理广播 (Broadcast)
      .on("broadcast", { event: "canvas_update" }, ({ payload }) => {
        if (payload.userId === userInfo.id || !excalidrawAPIRef.current) return;
        
        const localElements = excalidrawAPIRef.current.getSceneElements();
        const merged = mergeElements(localElements, payload.elements);
        
        // 【关键修复】开启远端更新锁，阻止引发本地 onChange 的广播回环
        isRemoteUpdatingRef.current = true;
        
        excalidrawAPIRef.current.updateScene({ 
          elements: merged,
          commitToHistory: false // 保护本地 Undo/Redo 队列不被远程笔画破坏
        });
        
        // 渲染完成后释放锁
        setTimeout(() => { isRemoteUpdatingRef.current = false; }, 0);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ name: userInfo.name, pointer: null });
        }
      });

    loadBoardToCanvas(currentBoard);

    return () => { supabase.removeChannel(channel); };
  }, [currentBoard?.id, userInfo.id]);

  const loadBoardToCanvas = (board) => {
    if (!excalidrawAPIRef.current || !board) return;
    let elements = [];
    try {
      elements = typeof board.content === "string" ? JSON.parse(board.content) : board.content || [];
    } catch { elements = []; }
    
    latestElementsRef.current = elements;
    excalidrawAPIRef.current.updateScene({ elements });
  };

  // ---------------- 4. 统一标准的核心 onChange 处理 ----------------
  const handleOnChange = (elements, appState, files) => {
    if (!currentBoard) return;
    
    // 【关键修复】如果是由于接收远端数据引发的重绘，直接拒绝触发广播，打破死循环
    if (isRemoteUpdatingRef.current) return;

    // 实时更新本地最新状态引用
    latestElementsRef.current = elements;

    // A. 【高频节流广播】(Leading + Trailing 双沿平衡节流，作画时 70ms 稳健同步)
    if (channelRef.current) {
      if (!broadcastThrottlingRef.current) {
        // 第一笔无延迟瞬间发出
        channelRef.current.send({
          type: "broadcast",
          event: "canvas_update",
          payload: { userId: userInfo.id, elements }
        });
        broadcastThrottlingRef.current = true;
        
        // 节流期内限制高频重复发送，到期自动补发最后一帧
        setTimeout(() => {
          broadcastThrottlingRef.current = false;
          if (channelRef.current) {
            channelRef.current.send({
              type: "broadcast",
              event: "canvas_update",
              payload: { userId: userInfo.id, elements: latestElementsRef.current }
            });
          }
        }, 70);
      }
    }

    // B. 【低频持久化落库】(停止移动 1.5秒 后防抖写入 Supabase 数据库)
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setIsSaving(true);
      await supabase
        .from("whiteboards")
        .update({ content: latestElementsRef.current, updated_at: new Date().toISOString() })
        .eq("id", currentBoard.id);
      setIsSaving(false);
    }, 1500);
  };

  // 实时同步鼠标移动轨迹
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

  // ---------------- 5. 业务板块 ----------------
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

  // ---------------- 6. 动态全屏布局样式 ----------------
  const layoutStyles = {
    container: { 
      display: "flex", 
      height: "100vh", 
      width: "100vw",
      backgroundColor: "#f8f9fa", 
      padding: isSidebarOpen ? "14px" : "0px", // 收起时边距彻底归零
      gap: isSidebarOpen ? "14px" : "0px",     // 收起时间隙彻底归零
      boxSizing: "border-box", 
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
      boxShadow: "0 4px 12px rgba(0,0,0,0.03)", 
      overflow: "hidden",
      whiteSpace: "nowrap"
    },
    main: { 
      flex: 1, 
      borderRadius: isSidebarOpen ? "16px" : "0px", // 收起时画布外框直角化，无缝贴合屏幕
      background: "#ffffff", 
      display: "flex", 
      flexDirection: "column", 
      overflow: "hidden", 
      position: "relative",
      boxShadow: isSidebarOpen ? "0 4px 24px rgba(0,0,0,0.06)" : "none" 
    }
  };

  return (
    <div className="sidebar-transition" style={layoutStyles.container}>
      
      {/* 左侧栏 */}
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
            我的私密白板
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

          <div style={{ ...styles.sectionTitle, marginTop: "24px" }}>🌐 公共大厅</div>
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
          <div style={styles.pulseDot}></div> 房间内在线: {onlineUsers.size}
        </div>
      </div>

      {/* 主画布右侧区域 */}
      <div className="sidebar-transition" style={layoutStyles.main}>
        
        {/* 顶部悬浮控制卡片 */}
        <div style={{ position: "absolute", top: 16, left: 16, zIndex: 10, display: "flex", gap: "12px", alignItems: "center" }}>
          <button 
            onClick={() => setIsSidebarOpen(!isSidebarOpen)} 
            style={styles.toggleSidebarBtn}
            title={isSidebarOpen ? "收起左栏全屏" : "展开左栏面板"}
          >
            {isSidebarOpen ? "◀" : "▶"}
          </button>
          
          <div style={styles.floatingTitleCard}>
            <span style={{ fontWeight: 600 }}>{currentBoard?.title || "未选择白板"}</span>
            {currentBoard && <span style={styles.tag}>{currentBoard.is_public ? "公共" : "私密"}</span>}
            <span style={{ fontSize: "12px", marginLeft: "8px", color: isSaving ? "#f29900" : "#34a853" }}>
              {isSaving ? "云同步中..." : "已保存到云"}
            </span>
          </div>
        </div>

        <div style={{ flex: 1, position: "relative" }}>
          <Excalidraw
            excalidrawAPI={(api) => { excalidrawAPIRef.current = api; }}
            onChange={handleOnChange}                // 完美匹配最新三参数规范并做高速节流
            onPointerUpdate={handlePointerUpdate}   // 协同多光标捕获
            theme="light"
            UIOptions={{ canvasActions: { toggleTheme: false } }}
          />
        </div>
      </div>

    </div>
  );
}

// ---------------- 基础视觉样式配置 ----------------
const styles = {
  userInfoCard: { display: "flex", gap: "12px", alignItems: "center", marginBottom: "20px", paddingBottom: "16px", borderBottom: "1px solid #e8eaed" },
  avatar: { width: "40px", height: "40px", borderRadius: "50%", backgroundColor: "#1a73e8", color: "#fff", display: "flex", justifyContent: "center", alignItems: "center", fontSize: "16px", fontWeight: "bold" },
  userName: { fontWeight: "600", color: "#202124", fontSize: "14px" },
  userStatus: { fontSize: "11px", marginTop: "4px", fontWeight: 600 },
  scrollArea: { flex: 1, overflowY: "auto" },
  sectionTitle: { display: "flex", justifyContent: "space-between", alignItems: "center", fontWeight: "700", color: "#5f6368", fontSize: "12px", marginBottom: "12px", letterSpacing: "0.3px" },
  roomItem: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderRadius: "8px", cursor: "pointer", background: "#fff", marginBottom: "8px", border: "1px solid transparent", transition: "all 0.2s" },
  truncate: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: "13px", color: "#3c4043", fontWeight: "500", maxWidth: "100px" },
  ownerTag: { fontSize: "11px", color: "#80868b", marginTop: "2px" },
  actions: { display: "flex", gap: "2px" },
  fabBtn: { borderRadius: "50%", width: "24px", height: "24px", border: "none", background: "#1a73e8", color: "#fff", cursor: "pointer", fontSize: "16px", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 4px rgba(26,115,232,0.2)" },
  textBtn: { fontSize: "11px", padding: "4px 6px", borderRadius: "4px", border: "none", background: "transparent", color: "#1a73e8", cursor: "pointer", fontWeight: "600" },
  onlineBadge: { marginTop: "16px", padding: "10px", background: "#e6f4ea", borderRadius: "8px", fontSize: "12px", color: "#137333", display: "flex", alignItems: "center", gap: "8px", fontWeight: "600" },
  pulseDot: { width: "8px", height: "8px", backgroundColor: "#34A853", borderRadius: "50%" },
  
  // 悬浮 UI 设计
  toggleSidebarBtn: { width: "40px", height: "40px", borderRadius: "8px", border: "none", background: "#ffffff", color: "#5f6368", cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,0.12)", display: "flex", justifyContent: "center", alignItems: "center", fontSize: "12px" },
  floatingTitleCard: { display: "flex", alignItems: "center", gap: "8px", padding: "0 16px", height: "40px", background: "#ffffff", borderRadius: "8px", boxShadow: "0 2px 8px rgba(0,0,0,0.12)", fontSize: "13px", color: "#202124" },
  tag: { fontSize: "10px", padding: "2px 6px", background: "#e8f0fe", color: "#1a73e8", borderRadius: "4px", fontWeight: "600" }
};