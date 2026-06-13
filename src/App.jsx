import React, { useState, useEffect, useRef } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { createClient } from "@supabase/supabase-js";

// ---------------- Supabase 配置 ----------------
const SUPABASE_URL = "https://mamubvgmcetepllznifl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HEeNPSqD75cWlnmZjcVHKA_Pw-OdL_A";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------- 注入 Google Material Design 3 动态样式 ----------------
const injectMaterialStyles = () => {
  if (document.getElementById("md3-styles")) return;
  const style = document.createElement("style");
  style.id = "md3-styles";
  style.innerHTML = `
    .md-btn { transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); position: relative; overflow: hidden; }
    .md-btn:hover { background-color: rgba(26, 115, 232, 0.08) !important; }
    .md-btn:active { transform: scale(0.95); background-color: rgba(26, 115, 232, 0.16) !important; }
    .md-fab { box-shadow: 0px 3px 5px -1px rgba(0,0,0,0.2), 0px 6px 10px 0px rgba(0,0,0,0.14); transition: box-shadow 0.2s; }
    .md-fab:hover { box-shadow: 0px 5px 8px -3px rgba(0,0,0,0.2), 0px 8px 16px 1px rgba(0,0,0,0.14); }
    .md-card { transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1); border: 1px solid #e0e0e0; }
    .md-card:hover { transform: translateY(-2px); box-shadow: 0px 4px 20px rgba(0, 0, 0, 0.08); border-color: #1a73e8; }
    .sidebar { transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s, padding 0.3s; }
    .sidebar.collapsed { width: 0px; padding: 0; opacity: 0; overflow: hidden; margin: 0; }
    .truncate-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `;
  document.head.appendChild(style);
};

const getRandomColor = () => {
  const colors = ["#b71c1c", "#4a148c", "#1a237e", "#01579b", "#006064", "#1b5e20", "#f57f17", "#e65100"];
  return colors[Math.floor(Math.random() * colors.length)];
};

// ---------------- App 组件 ----------------
export default function App() {
  // ---------------- 状态 ----------------
  const [userInfo, setUserInfo] = useState({ id: "", name: "访客", isLoggedIn: false, color: "#1a73e8" });
  const [publicBoards, setPublicBoards] = useState([]);
  const [privateBoards, setPrivateBoards] = useState([]);
  const [currentBoard, setCurrentBoard] = useState(null);
  const [onlineCount, setOnlineCount] = useState(1);
  const [isSaving, setIsSaving] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // ---------------- 核心引用锁与控制器 ----------------
  const excalidrawAPIRef = useRef(null);
  const saveTimer = useRef(null);
  const lastSavedRef = useRef("");
  const channelRef = useRef(null);
  
  // 🔥 关键远程更新锁，使用 useRef 确保同步阻塞，避免 React state 的异步可变空隙
  const isApplyingRemote = useRef(false);
  // 使用 Ref 追踪当前白板 ID，防止全局单通道监听器产生闭包旧值问题
  const currentBoardRef = useRef(null);

  useEffect(() => {
    injectMaterialStyles();
    currentBoardRef.current = currentBoard;
  }, [currentBoard]);

  // ---------------- 初始化用户 ----------------
  useEffect(() => {
    const initUser = async () => {
      const uniqueId = Math.random().toString(36).substring(2, 11);
      const userColor = getRandomColor();
      try {
        const res = await fetch("/api/userinfo");
        if (res.ok) {
          const data = await res.json();
          setUserInfo({ id: uniqueId, name: data.username, isLoggedIn: true, color: userColor });
        } else {
          setUserInfo({ id: uniqueId, name: `访客_${Math.floor(Math.random() * 100)}`, isLoggedIn: false, color: userColor });
        }
      } catch {
        setUserInfo({ id: uniqueId, name: `访客_${Math.floor(Math.random() * 100)}`, isLoggedIn: false, color: userColor });
      }
    };
    initUser();
  }, []);

  // 依赖并确保在得到用户信息后执行列表获取
  useEffect(() => {
    if (userInfo.name) fetchBoards();
  }, [userInfo.name]);

  // ---------------- 获取白板列表 ----------------
  const fetchBoards = async () => {
    const { data, error } = await supabase
      .from("whiteboards")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) return console.error("获取白板失败:", error);

    const publicList = data.filter(b => b.is_public);
    const privateList = data.filter(b => b.owner === userInfo.name && !b.is_public);

    setPublicBoards(publicList);
    setPrivateBoards(privateList);

    if (!currentBoardRef.current) {
      if (privateList.length > 0) setCurrentBoard(privateList[0]);
      else if (publicList.length > 0) setCurrentBoard(publicList[0]);
      else setCurrentBoard({
        id: "guest_board",
        title: "临时白板",
        owner: userInfo.name,
        is_public: false,
        content: []
      });
    }
  };

  // ---------------- STEP 1 & 3 & 6：全局单 Channel 建立与监听 ----------------
  useEffect(() => {
    if (!userInfo.id) return;

    // 建立唯一的全局协同房间
    const channel = supabase.channel("global-board-room", {
      config: { presence: { key: userInfo.id } }
    });
    channelRef.current = channel;

    channel
      // 🌟 监听画布元素实时广播 (CRDT-lite)
      .on("broadcast", { event: "scene_update" }, ({ payload }) => {
        if (!payload || !excalidrawAPIRef.current) return;
        // ❗ 锁1：防止自己发出的广播再次响应自己
        if (payload.userId === userInfo.id) return;
        // ❗ 锁2：只接收与当前激活白板一致的数据变更
        if (payload.boardId !== currentBoardRef.current?.id) return;
        // ❗ 锁3：如果本地正在应用更新中，直接拦截阻止回环
        if (isApplyingRemote.current) return;

        isApplyingRemote.current = true;
        try {
          excalidrawAPIRef.current.updateScene({
            elements: payload.elements,
            commitToHistory: false // 防止破坏本地的 Undo/Redo 历史栈
          });
          lastSavedRef.current = JSON.stringify(payload.elements);
        } finally {
          // 极短延迟后解开机制锁
          setTimeout(() => { isApplyingRemote.current = false; }, 50);
        }
      })
      // 🌟 多人实时光标与“选区高亮框”高频同步
      .on("broadcast", { event: "pointer_update" }, ({ payload }) => {
        if (!payload || !excalidrawAPIRef.current) return;
        if (payload.userId === userInfo.id || payload.boardId !== currentBoardRef.current?.id) return;

        const api = excalidrawAPIRef.current;
        const currentCollaborators = api.getAppState().collaborators || new Map();
        const updatedCollaborators = new Map(currentCollaborators);

        updatedCollaborators.set(payload.userId, {
          pointer: payload.pointer,
          button: payload.button || "up",
          selectedElementIds: payload.selectedElementIds || {},
          username: payload.username,
          color: payload.color
        });

        api.updateScene({ collaborators: updatedCollaborators });
      })
      // 🌟 STEP 6：精准修复在线人数 (按当前房间隔离过滤)
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        let currentRoomCount = 0;
        
        Object.values(state).forEach((presencePresences) => {
          const userPres = presencePresences[0];
          if (userPres && userPres.boardId === currentBoardRef.current?.id) {
            currentRoomCount++;
          }
        });
        setOnlineCount(currentRoomCount > 0 ? currentRoomCount : 1);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED" && currentBoardRef.current) {
          channel.track({
            id: userInfo.id,
            name: userInfo.name,
            color: userInfo.color,
            boardId: currentBoardRef.current.id
          });
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userInfo.id]);

  // 当切换房间时，及时更新 Presence 状态内的房间映射
  useEffect(() => {
    if (channelRef.current && currentBoard?.id && userInfo.id) {
      channelRef.current.track({
        id: userInfo.id,
        name: userInfo.name,
        color: userInfo.color,
        boardId: currentBoard.id
      });
    }
  }, [currentBoard?.id]);

  // ---------------- STEP 5：修复 Excalidraw 加载时机 ----------------
  const loadBoardToCanvas = (board) => {
    const api = excalidrawAPIRef.current;
    if (!api || !board) return;

    let elements = [];
    try {
      elements = typeof board.content === "string" && board.content.trim() !== ""
        ? JSON.parse(board.content)
        : board.content || [];
    } catch (err) {
      console.error("解析白板数据失败:", err);
      elements = [];
    }

    isApplyingRemote.current = true;
    api.updateScene({ elements });
    lastSavedRef.current = JSON.stringify(elements);
    setTimeout(() => { isApplyingRemote.current = false; }, 100);
  };

  useEffect(() => {
    if (currentBoard && excalidrawAPIRef.current) {
      loadBoardToCanvas(currentBoard);
    }
  }, [currentBoard?.id, excalidrawAPIRef.current]);

  // ---------------- STEP 2 & 4：修复 Excalidraw onChange 响应 ----------------
  const handleOnChange = (elements) => {
    // ❗ 关键防护锁：如果是接收到外部远程更新而引发的 onChange 触发现象，直接跳出阻断广播
    if (isApplyingRemote.current) return;
    if (!currentBoard) return;

    const json = JSON.stringify(elements);
    if (json === lastSavedRef.current) return;

    lastSavedRef.current = json;

    // 1. 实时的毫秒级内存同步广播 (不再重新构建 channel，直接发送)
    channelRef.current?.send({
      type: "broadcast",
      event: "scene_update",
      payload: {
        boardId: currentBoard.id,
        userId: userInfo.id,
        elements
      }
    });

    // 2. 数据库低频防抖持久化快照 (1秒延迟)
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      if (currentBoard.id === "guest_board") return;
      setIsSaving(true);
      const { error } = await supabase
        .from("whiteboards")
        .update({ content: elements, updated_at: new Date().toISOString() })
        .eq("id", currentBoard.id);
      setIsSaving(false);
      if (error) console.error("快照保存失败:", error);
    }, 1000);
  };

  // ---------------- 多人实时光标触发源 ----------------
  const handlePointerUpdate = (payload) => {
    if (!currentBoard || !channelRef.current) return;
    channelRef.current.send({
      type: "broadcast",
      event: "pointer_update",
      payload: {
        boardId: currentBoard.id,
        userId: userInfo.id,
        username: userInfo.name,
        color: userInfo.color,
        pointer: payload.pointer,
        button: payload.button,
        selectedElementIds: payload.selectedElementIds
      }
    });
  };

  // ---------------- 白板业务操作 ----------------
  const handleCreateBoard = async () => {
    if (!userInfo.isLoggedIn) return alert("请先登录账户");
    const title = prompt("请输入新白板名称：");
    if (!title) return;

    const newBoard = {
      title,
      owner: userInfo.name,
      content: [],
      is_public: false
    };

    const { data, error } = await supabase.from("whiteboards").insert([newBoard]).select().single();
    if (error) return console.error(error);

    setPrivateBoards(prev => [data, ...prev]);
    setCurrentBoard(data);
  };

  // 公开/私密 状态切换
  const handleTogglePrivacy = async (board, e) => {
    e.stopPropagation();
    if (!userInfo.isLoggedIn || board.owner !== userInfo.name) return alert("您无权操作该白板");
    
    const targetPrivacy = !board.is_public;
    const { data, error } = await supabase
      .from("whiteboards")
      .update({ is_public: targetPrivacy })
      .eq("id", board.id)
      .select()
      .single();

    if (error) return console.error(error);
    await fetchBoards();
    if (currentBoard?.id === board.id) setCurrentBoard(data);
  };

  // 删除自己的公共/私有白板
  const handleDeleteBoard = async (board, e) => {
    e.stopPropagation();
    if (board.owner !== userInfo.name) return alert("只能删除由您创建的白板");
    if (!window.confirm(`确认要销毁白板「${board.title}」吗？数据将不可恢复。`)) return;

    const { error } = await supabase.from("whiteboards").delete().eq("id", board.id);
    if (error) return console.error("删除失败:", error);

    if (currentBoard?.id === board.id) {
      setCurrentBoard(null);
    }
    await fetchBoards();
  };

  // ---------------- UI 渲染 ----------------
  return (
    <div style={styles.container}>
      {/* 侧边栏卡片区域 */}
      <div className={`sidebar ${!isSidebarOpen ? "collapsed" : ""}`} style={styles.sidebar}>
        {/* 用户信息卡片 (MD3 Tonal Muted) */}
        <div style={styles.userInfoCard}>
          <div style={{ ...styles.avatar, backgroundColor: userInfo.color }}>{userInfo.name.charAt(0).toUpperCase()}</div>
          <div style={{ overflow: "hidden" }}>
            <div className="truncate-text" style={styles.userName}>{userInfo.name}</div>
            <div style={styles.userStatus}>
              <span style={{ ...styles.statusDot, backgroundColor: userInfo.isLoggedIn ? "#34A853" : "#9AA0A6" }}></span>
              {userInfo.isLoggedIn ? "账户登录状态" : "访客体验模式"}
            </div>
          </div>
        </div>

        {/* 列表滚动容器 */}
        <div style={styles.scrollSection}>
          {/* 私密白板列表 */}
          <div style={styles.roomSection}>
            <div style={styles.sectionTitle}>
              <span>🔒 我的私密白板</span>
              {userInfo.isLoggedIn && (
                <button className="md-btn md-fab" onClick={handleCreateBoard} style={styles.iconAddBtn}>+</button>
              )}
            </div>
            <div style={styles.roomList}>
              {privateBoards.map(board => (
                <div key={board.id} className="md-card" onClick={() => setCurrentBoard(board)} 
                     style={{ ...styles.roomItem, backgroundColor: currentBoard?.id === board.id ? "#e8f0fe" : "#ffffff" }}>
                  <span className="truncate-text" style={{ ...styles.boardItemTitle, color: currentBoard?.id === board.id ? "#1a73e8" : "#202124" }}>{board.title}</span>
                  <div style={styles.itemActions}>
                    <button className="md-btn" onClick={(e) => handleTogglePrivacy(board, e)} style={styles.textActionBtn}>公开</button>
                    <button className="md-btn" onClick={(e) => handleDeleteBoard(board, e)} style={styles.deleteActionBtn}>删除</button>
                  </div>
                </div>
              ))}
              {privateBoards.length === 0 && <div style={styles.emptyTip}>暂无私密画布</div>}
            </div>
          </div>

          {/* 公共白板大厅 */}
          <div style={{ ...styles.roomSection, marginTop: "24px" }}>
            <div style={styles.sectionTitle}>🌐 公共联机大厅</div>
            <div style={styles.roomList}>
              {publicBoards.map(board => (
                <div key={board.id} className="md-card" onClick={() => setCurrentBoard(board)} 
                     style={{ ...styles.roomItem, backgroundColor: currentBoard?.id === board.id ? "#e6f4ea" : "#ffffff" }}>
                  <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", flex: 1 }}>
                    <span className="truncate-text" style={{ ...styles.boardItemTitle, color: currentBoard?.id === board.id ? "#137333" : "#202124" }}>{board.title}</span>
                    <span className="truncate-text" style={styles.ownerTag}>创建者: {board.owner}</span>
                  </div>
                  <div style={styles.itemActions}>
                    {board.owner === userInfo.name && (
                      <>
                        <button className="md-btn" onClick={(e) => handleTogglePrivacy(board, e)} style={{ ...styles.textActionBtn, color: "#e65100" }}>设为私密</button>
                        <button className="md-btn" onClick={(e) => handleDeleteBoard(board, e)} style={styles.deleteActionBtn}>删除</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
              {publicBoards.length === 0 && <div style={styles.emptyTip}>当前没有任何公开看板</div>}
            </div>
          </div>
        </div>

        {/* 底部隔离：当前房间在线状态指示器 */}
        <div style={styles.onlineContainer}>
          <span style={styles.pulseRadar}></span>
          <span>当前画布连线人数: <strong style={{ fontSize: "14px" }}>{onlineCount}</strong> 人</span>
        </div>
      </div>

      {/* 右侧主画布视窗 */}
      <div style={styles.mainContainer}>
        {/* MD3 风格顶部操作条 */}
        <div style={styles.topHeaderBar}>
          <button className="md-btn" onClick={() => setIsSidebarOpen(!isSidebarOpen)} style={styles.sidebarToggleBtn}>
            {isSidebarOpen ? "隐藏侧栏 ◀" : "展开菜单 ▶"}
          </button>
          <div style={styles.headerTitleWrap}>
            <h2 style={styles.mainTitle}>{currentBoard?.title || "未选中任何白板"}</h2>
            {currentBoard && (
              <span style={{ ...styles.badgeTag, backgroundColor: currentBoard.is_public ? "#e6f4ea" : "#fce8e6", color: currentBoard.is_public ? "#137333" : "#c5221f" }}>
                {currentBoard.is_public ? "全网公开" : "专属私密"}
              </span>
            )}
          </div>
          <div>
            {isSaving ? (
              <div style={{ color: "#1a73e8", fontWeight: "500", display: "flex", alignItems: "center", gap: "6px" }}>
                <span className="md-btn" style={styles.spinningIcon}>⏳</span> 正在高速同步云端...
              </div>
            ) : (
              <div style={{ color: "#34A853", fontWeight: "500" }}>● 实配协同就绪</div>
            )}
          </div>
        </div>

        {/* Excalidraw 画布载体 */}
        <div style={{ flex: 1, position: "relative" }}>
          <Excalidraw
            excalidrawAPI={(api) => { excalidrawAPIRef.current = api; }}
            onChange={handleOnChange}
            onPointerUpdate={handlePointerUpdate}
            theme="light"
            UIOptions={{ canvasActions: { toggleTheme: false, saveAsImage: true } }}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------- MD3 高级视觉规范对象 ----------------
const styles = {
  container: { display: "flex", height: "100vh", gap: "14px", padding: "14px", backgroundColor: "#f7f9fc", boxSizing: "border-box" },
  sidebar: { width: "300px", backgroundColor: "#ffffff", borderRadius: "24px", display: "flex", flexDirection: "column", padding: "24px 18px", boxShadow: "0px 1px 3px rgba(0,0,0,0.02), 0px 1px 2px rgba(0,0,0,0.04)" },
  userInfoCard: { display: "flex", gap: "14px", alignItems: "center", backgroundColor: "#f3f6fc", padding: "14px", borderRadius: "16px", marginBottom: "20px" },
  avatar: { width: "42px", height: "42px", borderRadius: "50%", color: "#ffffff", display: "flex", justifyContent: "center", alignItems: "center", fontWeight: "700", fontSize: "18px", boxShadow: "0 2px 6px rgba(0,0,0,0.1)" },
  userName: { fontWeight: "600", fontSize: "15px", color: "#1f1f1f" },
  userStatus: { fontSize: "11px", color: "#5f6368", display: "flex", alignItems: "center", gap: "5px", marginTop: "3px" },
  statusDot: { width: "7px", height: "7px", borderRadius: "50%" },
  scrollSection: { flex: 1, overflowY: "auto", paddingRight: "4px" },
  roomSection: { display: "flex", flexDirection: "column" },
  sectionTitle: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "13px", fontWeight: "700", color: "#444746", marginBottom: "12px", letterSpacing: "0.4px" },
  roomList: { display: "flex", flexDirection: "column", gap: "8px" },
  roomItem: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", borderRadius: "14px", cursor: "pointer" },
  boardItemTitle: { fontSize: "14px", fontWeight: "600", maxWidth: "120px" },
  ownerTag: { fontSize: "11px", color: "#757575", marginTop: "3px" },
  itemActions: { display: "flex", gap: "6px" },
  iconAddBtn: { width: "28px", height: "28px", borderRadius: "50%", border: "none", backgroundColor: "#1a73e8", color: "#ffffff", fontSize: "16px", cursor: "pointer", display: "flex", justifyContent: "center", alignItems: "center" },
  textActionBtn: { border: "none", background: "none", color: "#1a73e8", fontSize: "12px", fontWeight: "600", cursor: "pointer", padding: "4px 8px", borderRadius: "6px" },
  deleteActionBtn: { border: "none", background: "none", color: "#b71c1c", fontSize: "12px", fontWeight: "600", cursor: "pointer", padding: "4px 8px", borderRadius: "6px" },
  emptyTip: { fontSize: "12px", color: "#9e9e9e", textAlign: "center", padding: "12px 0", fontStyle: "italic" },
  onlineContainer: { marginTop: "16px", padding: "12px 16px", backgroundColor: "#e8f0fe", borderRadius: "14px", fontSize: "12.5px", color: "#1a73e8", display: "flex", alignItems: "center", gap: "8px", fontWeight: "500" },
  pulseRadar: { width: "8px", height: "8px", backgroundColor: "#1a73e8", borderRadius: "50%", display: "inline-block" },
  mainContainer: { flex: 1, borderRadius: "24px", backgroundColor: "#ffffff", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0px 2px 6px rgba(0,0,0,0.06)" },
  topHeaderBar: { height: "64px", borderBottom: "1px solid #f1f3f4", display: "flex", alignItems: "center", padding: "0 20px", justifyContent: "space-between", backgroundColor: "#ffffff" },
  sidebarToggleBtn: { border: "1px solid #dadce0", backgroundColor: "#ffffff", padding: "6px 12px", borderRadius: "8px", fontSize: "12px", fontWeight: "600", color: "#444746", cursor: "pointer" },
  headerTitleWrap: { display: "flex", alignItems: "center", gap: "10px" },
  mainTitle: { fontSize: "16px", fontWeight: "700", color: "#1f1f1f", margin: 0 },
  badgeTag: { fontSize: "11px", padding: "3px 10px", borderRadius: "10px", fontWeight: "600" },
  spinningIcon: { display: "inline-block", border: "none", background: "none", padding: 0 }
};