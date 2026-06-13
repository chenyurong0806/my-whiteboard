import React, { useState, useEffect, useRef, useCallback } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { createClient } from "@supabase/supabase-js";

// ---------------- Supabase 配置 ----------------
const SUPABASE_URL = "https://mamubvgmcetepllznifl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HEeNPSqD75cWlnmZjcVHKA_Pw-OdL_A";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------- 注入 Material 动画 CSS ----------------
const injectCSS = () => {
  if (document.getElementById("material-styles")) return;
  const style = document.createElement("style");
  style.id = "material-styles";
  style.innerHTML = `
    .md-btn { transition: background-color 0.2s, transform 0.1s, box-shadow 0.2s; }
    .md-btn:active { transform: scale(0.95); }
    .md-card { transition: box-shadow 0.3s cubic-bezier(0.4, 0, 0.2, 1), transform 0.2s; }
    .md-card:hover { transform: translateY(-2px); box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
    .sidebar { transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s; }
    .sidebar.collapsed { width: 0px; padding: 0; opacity: 0; overflow: hidden; margin: 0; }
  `;
  document.head.appendChild(style);
};

// ---------------- 辅助：生成随机光标颜色 ----------------
const stringToColor = (str) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const color = Math.floor(Math.abs((Math.sin(hash) * 10000) % 1 * 16777215)).toString(16);
  return '#' + '000000'.substring(0, 6 - color.length) + color;
};

// ---------------- App ----------------
export default function App() {
  // ---------------- 状态 ----------------
  const [userInfo, setUserInfo] = useState({ id: "", name: "访客", isLoggedIn: false, color: "" });
  const [publicBoards, setPublicBoards] = useState([]);
  const [privateBoards, setPrivateBoards] = useState([]);
  const [currentBoard, setCurrentBoard] = useState(null);
  const [onlineUsers, setOnlineUsers] = useState(new Map());
  const [isSaving, setIsSaving] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const excalidrawAPIRef = useRef(null);
  const saveTimer = useRef(null);
  const broadcastTimer = useRef(null);
  const lastSavedRef = useRef("");
  const channelRef = useRef(null);

  useEffect(() => { injectCSS(); }, []);

  // ---------------- 初始化用户 ----------------
  useEffect(() => {
    const initUser = async () => {
      const randomId = Math.random().toString(36).substr(2, 9);
      try {
        const res = await fetch("/api/userinfo");
        if (res.ok) {
          const data = await res.json();
          setUserInfo({ id: randomId, name: data.username, isLoggedIn: true, color: stringToColor(data.username) });
        } else throw new Error();
      } catch {
        const guestName = `访客_${Math.floor(Math.random() * 100)}`;
        setUserInfo({ id: randomId, name: guestName, isLoggedIn: false, color: stringToColor(guestName) });
      }
      await fetchBoards();
    };
    initUser();
  }, []);

  // ---------------- 获取白板列表 ----------------
  const fetchBoards = async () => {
    const { data, error } = await supabase.from("whiteboards").select("*").order("created_at", { ascending: false });
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

  // ---------------- 实时频道 (Presence & Broadcast) ----------------
  useEffect(() => {
    if (!currentBoard?.id || !userInfo.id || !excalidrawAPIRef.current) return;

    // 清理旧频道
    if (channelRef.current) supabase.removeChannel(channelRef.current);

    const channel = supabase.channel(`board_${currentBoard.id}`, {
      config: { presence: { key: userInfo.id } }
    });
    channelRef.current = channel;

    channel
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
              selectedElementIds: userState.selectedElementIds || {},
              username: userState.name,
              color: userState.color
            });
          }
        });
        setOnlineUsers(users);
        if (excalidrawAPIRef.current) {
          excalidrawAPIRef.current.updateScene({ collaborators });
        }
      })
      .on("broadcast", { event: "scene_update" }, ({ payload }) => {
        // 接收远端作画广播 (CRDT-lite)
        if (payload.userId === userInfo.id) return;
        if (excalidrawAPIRef.current) {
          const currentElements = excalidrawAPIRef.current.getSceneElements();
          // 简单的冲突合并：依赖 Excalidraw 的内部版本控制合并
          excalidrawAPIRef.current.updateScene({
            elements: payload.elements,
            commitToHistory: false // 防止破坏本地 Undo/Redo 栈
          });
        }
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ name: userInfo.name, color: userInfo.color, pointer: null });
        }
      });

    // 初始加载数据库画布内容
    loadBoardToCanvas(currentBoard);

    return () => { supabase.removeChannel(channel); };
  }, [currentBoard?.id, userInfo.id]);

  // ---------------- 加载画布 ----------------
  const loadBoardToCanvas = (board) => {
    const api = excalidrawAPIRef.current;
    if (!api || !board) return;
    let elements = [];
    try {
      elements = typeof board.content === "string" ? JSON.parse(board.content) : board.content || [];
    } catch { elements = []; }
    api.updateScene({ elements });
    lastSavedRef.current = JSON.stringify(elements);
  };

  // ---------------- 画布变化 (节流广播 + 防抖保存) ----------------
  const handleOnChange = (elements, appState) => {
    if (!currentBoard) return;
    const json = JSON.stringify(elements);
    
    // 1. 高频广播：实时发给其他人 (100ms节流)
    if (channelRef.current && json !== lastSavedRef.current) {
      clearTimeout(broadcastTimer.current);
      broadcastTimer.current = setTimeout(() => {
        channelRef.current.send({
          type: "broadcast",
          event: "scene_update",
          payload: { userId: userInfo.id, elements }
        });
      }, 100);
    }

    if (json === lastSavedRef.current) return;

    // 2. 低频持久化：写入数据库 (1000ms防抖)
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setIsSaving(true);
      const { error } = await supabase.from("whiteboards").update({ content: elements, updated_at: new Date().toISOString() }).eq("id", currentBoard.id);
      setIsSaving(false);
      if (!error) lastSavedRef.current = json;
    }, 1000);
  };

  // ---------------- 实时光标同步 ----------------
  const handlePointerUpdate = (payload) => {
    if (channelRef.current) {
      channelRef.current.track({
        name: userInfo.name,
        color: userInfo.color,
        pointer: payload.pointer,
        button: payload.button,
        selectedElementIds: payload.selectedElementIds
      });
    }
  };

  // ---------------- 白板管理操作 ----------------
  const handleCreateBoard = async () => {
    if (!userInfo.isLoggedIn) return alert("请先登录");
    const title = prompt("请输入新白板名称");
    if (!title) return;
    const { data } = await supabase.from("whiteboards").insert([{ title, owner: userInfo.name, content: [], is_public: false }]).select().single();
    setPrivateBoards(prev => [data, ...prev]);
    setCurrentBoard(data);
  };

  const handleTogglePublish = async (board) => {
    if (!userInfo.isLoggedIn || board.owner !== userInfo.name) return alert("无权操作");
    const { data } = await supabase.from("whiteboards").update({ is_public: !board.is_public }).eq("id", board.id).select().single();
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
  return (
    <div style={styles.container}>
      {/* 侧边栏 */}
      <div className={`sidebar ${!isSidebarOpen ? 'collapsed' : ''}`} style={styles.sidebar}>
        <div style={styles.userInfoCard}>
          <div style={{ ...styles.avatar, backgroundColor: userInfo.color }}>{userInfo.name.charAt(0)}</div>
          <div>
            <div style={styles.userName}>{userInfo.name}</div>
            <div style={styles.userStatus}>
              <span style={{ ...styles.statusDot, backgroundColor: userInfo.isLoggedIn ? "#34A853" : "#9AA0A6" }}></span>
              {userInfo.isLoggedIn ? "已登录" : "访客模式"}
            </div>
          </div>
        </div>

        {/* 房间列表区 */}
        <div style={styles.scrollArea}>
          <div style={styles.roomSection}>
            <div style={styles.sectionTitle}>
              <span>我的私密</span>
              {userInfo.isLoggedIn && <button className="md-btn" onClick={handleCreateBoard} style={styles.fabBtn}>+</button>}
            </div>
            {privateBoards.map(board => (
              <div key={board.id} className="md-card" onClick={() => setCurrentBoard(board)} style={{...styles.roomItem, borderLeft: currentBoard?.id === board.id ? "4px solid #1a73e8" : "4px solid transparent"}}>
                <span style={styles.truncate}>{board.title}</span>
                <div style={styles.actions}>
                  <button className="md-btn" onClick={(e) => { e.stopPropagation(); handleTogglePublish(board); }} style={styles.textBtn}>公开</button>
                  <button className="md-btn" onClick={(e) => handleDeleteBoard(board, e)} style={{...styles.textBtn, color: "#d93025"}}>删</button>
                </div>
              </div>
            ))}
          </div>

          <div style={{ ...styles.roomSection, marginTop: "24px" }}>
            <div style={styles.sectionTitle}>公共大厅</div>
            {publicBoards.map(board => (
              <div key={board.id} className="md-card" onClick={() => setCurrentBoard(board)} style={{...styles.roomItem, borderLeft: currentBoard?.id === board.id ? "4px solid #34a853" : "4px solid transparent"}}>
                <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <span style={styles.truncate}>{board.title}</span>
                  <span style={styles.ownerTag}>by {board.owner}</span>
                </div>
                <div style={styles.actions}>
                  {board.owner === userInfo.name && (
                    <>
                      <button className="md-btn" onClick={(e) => { e.stopPropagation(); handleTogglePublish(board); }} style={{...styles.textBtn, color: "#f29900"}}>私有化</button>
                      <button className="md-btn" onClick={(e) => handleDeleteBoard(board, e)} style={{...styles.textBtn, color: "#d93025"}}>删</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 底部在线区 */}
        <div style={styles.onlineBadge}>
          <div style={styles.pulseDot}></div>当前房间在线: {onlineUsers.size}
        </div>
      </div>

      {/* 主画布区域 */}
      <div style={styles.main}>
        {/* 顶部控制条 */}
        <div style={styles.topBar}>
          <button className="md-btn" onClick={() => setIsSidebarOpen(!isSidebarOpen)} style={styles.iconBtn}>
            {isSidebarOpen ? "◀" : "▶"}
          </button>
          <div style={styles.boardTitle}>
            {currentBoard?.title || "未选择白板"} 
            {currentBoard && <span style={styles.tag}>{currentBoard.is_public ? "公共" : "私密"}</span>}
          </div>
          <div style={styles.syncStatus}>
            {isSaving ? <span style={{color: "#f29900"}}>云端同步中...</span> : <span style={{color: "#34a853"}}>已保存</span>}
          </div>
        </div>

        <div style={{ flex: 1, position: "relative" }}>
          <Excalidraw
            excalidrawAPI={(api) => { excalidrawAPIRef.current = api; }}
            onChange={handleOnChange}
            onPointerUpdate={handlePointerUpdate}
            theme="light"
            UIOptions={{ canvasActions: { toggleTheme: true } }}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------- 样式 (Material Design) ----------------
const styles = {
  container: { display: "flex", height: "100vh", backgroundColor: "#f0f2f5", padding: "12px", gap: "12px", boxSizing: "border-box", fontFamily: "Roboto, sans-serif" },
  sidebar: { width: "280px", background: "#ffffff", borderRadius: "16px", display: "flex", flexDirection: "column", padding: "20px 16px", boxShadow: "0 2px 6px rgba(0,0,0,0.05)", zIndex: 10 },
  userInfoCard: { display: "flex", gap: "12px", alignItems: "center", marginBottom: "24px", paddingBottom: "16px", borderBottom: "1px solid #e8eaed" },
  avatar: { width: "44px", height: "44px", borderRadius: "22px", color: "#fff", display: "flex", justifyContent: "center", alignItems: "center", fontSize: "18px", fontWeight: "bold", boxShadow: "0 2px 4px rgba(0,0,0,0.2)" },
  userName: { fontWeight: "600", color: "#202124", fontSize: "15px" },
  userStatus: { fontSize: "12px", color: "#5f6368", display: "flex", gap: "6px", alignItems: "center", marginTop: "4px" },
  statusDot: { width: "8px", height: "8px", borderRadius: "50%" },
  scrollArea: { flex: 1, overflowY: "auto", overflowX: "hidden", paddingRight: "4px" },
  roomSection: { display: "flex", flexDirection: "column" },
  sectionTitle: { display: "flex", justifyContent: "space-between", alignItems: "center", fontWeight: "700", color: "#5f6368", fontSize: "13px", marginBottom: "12px", textTransform: "uppercase", letterSpacing: "0.5px" },
  roomItem: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", borderRadius: "8px", cursor: "pointer", background: "#fff", marginBottom: "8px", border: "1px solid #dadce0" },
  truncate: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: "14px", color: "#3c4043", fontWeight: "500", maxWidth: "120px" },
  ownerTag: { fontSize: "11px", color: "#80868b", marginTop: "4px" },
  actions: { display: "flex", gap: "4px" },
  fabBtn: { borderRadius: "50%", width: "28px", height: "28px", border: "none", background: "#1a73e8", color: "#fff", cursor: "pointer", display: "flex", justifyContent: "center", alignItems: "center", fontSize: "18px", boxShadow: "0 2px 4px rgba(26,115,232,0.3)" },
  textBtn: { fontSize: "12px", padding: "4px 8px", borderRadius: "4px", border: "none", background: "rgba(0,0,0,0.04)", color: "#1a73e8", cursor: "pointer", fontWeight: "600" },
  onlineBadge: { marginTop: "16px", padding: "12px", background: "#e6f4ea", borderRadius: "8px", fontSize: "13px", color: "#137333", display: "flex", alignItems: "center", gap: "8px", fontWeight: "500" },
  pulseDot: { width: "8px", height: "8px", backgroundColor: "#34A853", borderRadius: "50%", boxShadow: "0 0 0 rgba(52, 168, 83, 0.4)" },
  main: { flex: 1, borderRadius: "16px", background: "#ffffff", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 2px 10px rgba(0,0,0,0.08)" },
  topBar: { height: "56px", borderBottom: "1px solid #e8eaed", display: "flex", alignItems: "center", padding: "0 16px", gap: "16px", background: "#fff" },
  iconBtn: { background: "#f1f3f4", border: "none", width: "36px", height: "36px", borderRadius: "50%", cursor: "pointer", color: "#5f6368", display: "flex", justifyContent: "center", alignItems: "center" },
  boardTitle: { flex: 1, fontSize: "16px", fontWeight: "600", color: "#202124", display: "flex", alignItems: "center", gap: "8px" },
  tag: { fontSize: "11px", padding: "2px 8px", background: "#e8f0fe", color: "#1a73e8", borderRadius: "12px", fontWeight: "500" },
  syncStatus: { fontSize: "13px", fontWeight: "500" }
};