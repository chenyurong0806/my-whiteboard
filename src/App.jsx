// App.jsx
import React, { useState, useEffect, useRef } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { createClient } from "@supabase/supabase-js";

// ---------------- Supabase 配置 ----------------
const SUPABASE_URL = "https://mamubvgmcetepllznifl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HEeNPSqD75cWlnmZjcVHKA_Pw-OdL_A";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------- 注入过渡动画样式 ----------------
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

// ---------------- 兼容性 JSONB 解析器 ----------------
const parseContent = (content) => {
  if (!content) return { elements: [], version: 0, senderId: "" };
  if (Array.isArray(content)) {
    return { elements: content, version: 0, senderId: "" };
  }
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return { elements: parsed, version: 0, senderId: "" };
      return {
        elements: parsed.elements || [],
        version: parsed.version || 0,
        senderId: parsed.senderId || ""
      };
    } catch {
      return { elements: [], version: 0, senderId: "" };
    }
  }
  return {
    elements: content.elements || [],
    version: content.version || 0,
    senderId: content.senderId || ""
  };
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
  
  // 核心控制 Ref
  const versionRef = useRef(0);                 // 🟢 本地版本计数器
  const isRemoteUpdatingRef = useRef(false);    // 远端更新状态锁
  const lastSaveTimeRef = useRef(0);            // 节流时间戳

  useEffect(() => { injectCSS(); }, []);

  // ---------------- 1. 初始化用户与列表 ----------------
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

  // ---------------- 2. 实时数据库变更与光标监听 ----------------
  useEffect(() => {
    if (!currentBoard?.id || !userInfo.id) return;

    if (channelRef.current) supabase.removeChannel(channelRef.current);

    // 订阅当前画布频道
    const channel = supabase.channel(`board_${currentBoard.id}`);
    channelRef.current = channel;

    channel
      // 🟢 A. 监听 Postgres Changes 数据表 UPDATE 变更
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "whiteboards",
          filter: `id=eq.${currentBoard.id}`
        },
        (payload) => {
          const remoteContent = parseContent(payload.new.content);

          // 🟢 接收端 version 判断：如果是自己发的，或者版本不高于当前版本，则直接丢弃
          if (remoteContent.senderId === userInfo.id || remoteContent.version <= versionRef.current) {
            return;
          }

          // 同步远程版本号
          versionRef.current = remoteContent.version;

          // 开启状态锁，阻止 updateScene 再次触发本地 onChange 发起二次保存
          isRemoteUpdatingRef.current = true;
          excalidrawAPIRef.current.updateScene({
            elements: remoteContent.elements,
            commitToHistory: false
          });
          
          // 渲染缓冲释放
          setTimeout(() => { isRemoteUpdatingRef.current = false; }, 50);
        }
      )
      // 🟢 B. 更改后的轻量级 Broadcast Payload (专职负责指针渲染)
      .on("broadcast", { event: "pointer_update" }, ({ payload }) => {
        if (payload.userId === userInfo.id || !excalidrawAPIRef.current) return;
        
        const collaborators = new Map(excalidrawAPIRef.current.getCollaborators());
        collaborators.set(payload.userId, {
          pointer: payload.pointer,
          button: payload.button || "up",
          username: payload.name,
          selectedElementIds: payload.selectedElementIds || {}
        });
        
        excalidrawAPIRef.current.updateScene({ collaborators });
      })
      // C. 在线状态人数统计
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        setOnlineUsers(new Map(Object.entries(state)));
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ name: userInfo.name });
        }
      });

    loadBoardToCanvas(currentBoard);

    return () => { supabase.removeChannel(channel); };
  }, [currentBoard?.id, userInfo.id]);

  const loadBoardToCanvas = (board) => {
    if (!excalidrawAPIRef.current || !board) return;
    const parsed = parseContent(board.content);
    
    versionRef.current = parsed.version; // 初始化本地版本指针
    isRemoteUpdatingRef.current = true;
    excalidrawAPIRef.current.updateScene({ elements: parsed.elements });
    setTimeout(() => { isRemoteUpdatingRef.current = false; }, 50);
  };

  // ---------------- 3. 规范化的标准 onChange 处理 ----------------
  const handleOnChange = (elements, appState, files) => {
    if (!currentBoard) return;
    // 如果是远程同步引发的画布重绘，直接拦截
    if (isRemoteUpdatingRef.current) return;

    const now = Date.now();
    const THROTTLE_INTERVAL = 300; // 300ms 高频流控节流阀

    clearTimeout(saveTimer.current);

    // 🟢 核心归档：DB只做存档，依靠写库触发逻辑复制通知其他人
    const executeDBSave = async () => {
      versionRef.current += 1; // 递增本地版本号
      setIsSaving(true);

      const wrappedPayload = {
        elements: elements,
        version: versionRef.current,
        senderId: userInfo.id
      };

      await supabase
        .from("whiteboards")
        .update({ 
          content: wrappedPayload, 
          updated_at: new Date().toISOString() 
        })
        .eq("id", currentBoard.id);

      setIsSaving(false);
      lastSaveTimeRef.current = Date.now();
    };

    if (now - lastSaveTimeRef.current >= THROTTLE_INTERVAL) {
      executeDBSave();
    } else {
      // 尾部防抖，确保松开画笔后的最后一帧绝对不丢失
      saveTimer.current = setTimeout(executeDBSave, THROTTLE_INTERVAL);
    }
  };

  // 🟢 规范后的实时指针轨迹 Broadcast 发生器
  const handlePointerUpdate = (payload) => {
    if (channelRef.current) {
      channelRef.current.send({
        type: "broadcast",
        event: "pointer_update",
        payload: {
          userId: userInfo.id,
          name: userInfo.name,
          pointer: payload.pointer,
          button: payload.button,
          selectedElementIds: payload.selectedElementIds
        }
      });
    }
  };

  // ---------------- 4. 业务数据操作 ----------------
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

  // ---------------- 5. 动态画布全屏样式处理 ----------------
  const layoutStyles = {
    container: { 
      display: "flex", 
      height: "100vh", 
      width: "100vw",
      backgroundColor: "#f8f9fa", 
      padding: isSidebarOpen ? "14px" : "0px", // 收起时全局外边距清零
      gap: isSidebarOpen ? "14px" : "0px",     // 收起时元素框间隙清零
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
      borderRadius: isSidebarOpen ? "16px" : "0px", // 收起时圆角直角化，无缝拼接视口边缘
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
      
      {/* 左侧抽屉栏 */}
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

      {/* 沉浸式全屏画布区域 */}
      <div className="sidebar-transition" style={layoutStyles.main}>
        
        {/* 控制浮层 */}
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
            onChange={handleOnChange}                {/* 规范后的三参数标准写法 */}
            onPointerUpdate={handlePointerUpdate}   {/* 改动后的轻量级广播载荷 */}
            theme="light"
            UIOptions={{ canvasActions: { toggleTheme: false } }}
          />
        </div>
      </div>

    </div>
  );
}

// ---------------- 样式字典 ----------------
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
  toggleSidebarBtn: { width: "40px", height: "40px", borderRadius: "8px", border: "none", background: "#ffffff", color: "#5f6368", cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,0.12)", display: "flex", justifyContent: "center", alignItems: "center", fontSize: "12px" },
  floatingTitleCard: { display: "flex", alignItems: "center", gap: "8px", padding: "0 16px", height: "40px", background: "#ffffff", borderRadius: "8px", boxShadow: "0 2px 8px rgba(0,0,0,0.12)", fontSize: "13px", color: "#202124" },
  tag: { fontSize: "10px", padding: "2px 6px", background: "#e8f0fe", color: "#1a73e8", borderRadius: "4px", fontWeight: "600" }
};