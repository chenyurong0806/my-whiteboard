import { useEffect, useState, useRef } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import { createClient } from "@supabase/supabase-js";
import "@excalidraw/excalidraw/index.css";

const SUPABASE_URL = "https://mamubvgmcetepllznifl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HEeNPSqD75cWlnmZjcVHKA_Pw-OdL_A";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function App() {
  const [userInfo, setUserInfo] = useState({ name: "访客", isLoggedIn: false });
  const [privateBoards, setPrivateBoards] = useState([]);
  const [publicBoards, setPublicBoards] = useState([]);
  const [currentBoard, setCurrentBoard] = useState(null); 
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [excalidrawAPI, setExcalidrawAPI] = useState(null);
  const [isSaving, setIsSaving] = useState(false); // 保存状态锁

  // === 性能与纯前端同步锁 ===
  const isReceiving = useRef(false);
  const isInitialLoading = useRef(false);
  const lastBroadcastTime = useRef(0);
  const lastVersionSum = useRef(0);
  const channelRef = useRef(null);

  // 1. 初始化用户信息与列表（只在页面首次打开时向后端发一次请求）
  useEffect(() => {
    const initApp = async () => {
      let currentUser = { name: `访客_${Math.floor(Math.random() * 100)}`, isLoggedIn: false };
      try {
        const res = await fetch("/api/userinfo");
        if (res.ok) {
          const data = await res.json();
          currentUser = { name: data.username, isLoggedIn: true };
        }
      } catch (e) {
        console.warn("未检测到真实登录接口，默认开启访客模式");
      }
      setUserInfo(currentUser);
      fetchBoards(currentUser, true); // 传入 true 表示允许自动选择默认白板
    };
    initApp();
  }, []);

  // 从数据库拉取所有白板的最新列表与内容
  const fetchBoards = async (user, autoSelect = false) => {
    const { data, error } = await supabase.from("whiteboards").select("*").order('created_at', { ascending: false });
    if (error) return console.error("拉取数据库失败:", error);

    const publicList = [];
    const privateList = [];
    data.forEach(board => {
      if (board.is_public) publicList.push(board);
      else if (user.isLoggedIn && board.owner === user.name) privateList.push(board);
    });

    setPublicBoards(publicList);
    setPrivateBoards(privateList);

    // 仅在初始化且没有选择白板时，才自动载入第一个
    if (autoSelect) {
      if (privateList.length > 0) handleSelectBoard(privateList[0]);
      else if (publicList.length > 0) handleSelectBoard(publicList[0]);
      else handleSelectBoard({ id: "local_guest", title: "临时白板(不保存)", is_public: false, owner: user.name, content: [] });
    }
  };

  // 2. 核心：点击切换白板（从数据库拉取最新的画作内容，直接呈现在画布上）
  const handleSelectBoard = async (board) => {
    setCurrentBoard(board);
    if (!excalidrawAPI) return;

    // 开启初始化锁，防止组件加载时把空画布当成用户的改动广播出去
    isInitialLoading.current = true;
    
    // 把从数据库拿到的内容渲染到画布
    excalidrawAPI.updateScene({ elements: board.content || [] });
    lastVersionSum.current = (board.content || []).reduce((sum, el) => sum + el.version, 0);

    // 延迟解锁，确保组件完全渲染完毕
    setTimeout(() => { isInitialLoading.current = false; }, 300);
  };

  // 当 excalidrawAPI 准备就绪时，补全首次渲染
  useEffect(() => {
    if (excalidrawAPI && currentBoard) {
      handleSelectBoard(currentBoard);
    }
  }, [excalidrawAPI]);

  // 3. 实时通讯房间：进入单独的房间，完全不与数据库交互
  useEffect(() => {
    if (!excalidrawAPI || !currentBoard) return;

    setOnlineUsers([]);
    if (!currentBoard.is_public) return; // 如果不是公开画布，不开启实时联机房间

    const channelName = `room-${currentBoard.id}`;
    const roomChannel = supabase.channel(channelName, {
      config: { presence: { key: userInfo.name } },
    });

    channelRef.current = roomChannel;

    roomChannel
      .on("broadcast", { event: "draw-sync" }, ({ payload }) => {
        // 收到其他前端传来的数据，直接呈现在画布上，不经过数据库
        isReceiving.current = true;
        lastVersionSum.current = payload.elements.reduce((sum, el) => sum + el.version, 0);
        excalidrawAPI.updateScene({ elements: payload.elements });
        setTimeout(() => { isReceiving.current = false; }, 50);
      })
      .on("presence", { event: "sync" }, () => {
        const presenceState = roomChannel.presenceState();
        const users = Object.keys(presenceState).map(key => ({ name: key }));
        setOnlineUsers(users);
      })
      .on("presence", { event: "join" }, ({ newPresences }) => {
        // 🌟 【黄金逻辑】当有新用户进入网页时，当前房间内的老用户直接将自己画布上的内容“甩”给新来的人
        // 这样新用户进房立刻就能同步到最新的画作，根本不需要去读写数据库！
        if (newPresences.length > 0 && !isInitialLoading.current) {
          roomChannel.send({
            type: "broadcast",
            event: "draw-sync",
            payload: { elements: excalidrawAPI.getSceneElements() },
          });
        }
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await roomChannel.track({ user: userInfo.name });
        }
      });

    return () => {
      supabase.removeChannel(roomChannel);
      channelRef.current = null;
    };
  }, [excalidrawAPI, currentBoard?.id, currentBoard?.is_public, userInfo.name]);

  // 4. 作画过程中的 onChange 监听（纯前端传递，0 数据库交互）
  const handleOnChange = (elements) => {
    if (!currentBoard || isReceiving.current || isInitialLoading.current) return;

    // 过滤掉无关的缩放、平移等非作画改动
    const currentSum = elements.reduce((sum, el) => sum + el.version, 0);
    if (currentSum === lastVersionSum.current) return;
    lastVersionSum.current = currentSum;

    // 实时同步缓存在本地内存中
    currentBoard.content = elements;

    // 如果在公共画布房，直接在前端之间高频传递数据
    if (currentBoard.is_public && channelRef.current) {
      const now = Date.now();
      if (now - lastBroadcastTime.current > 60) { // Throttling 60ms
        lastBroadcastTime.current = now;
        channelRef.current.send({
          type: "broadcast",
          event: "draw-sync",
          payload: { elements },
        });
      }
    }
  };

  // 5. 🌟 新增功能：提供一个按钮，手动与数据库同步保存
  const handleManualSave = async () => {
    if (!userInfo.isLoggedIn) return alert("❌ 请先在左侧切换为【已登录模式】再保存！");
    if (!currentBoard || currentBoard.id === "local_guest") return alert("本地临时白板无法保存到云端");

    setIsSaving(true);
    // 获取当前画布上最真实的图形数据
    const latestElements = excalidrawAPI ? excalidrawAPI.getSceneElements() : currentBoard.content;

    const { error } = await supabase
      .from("whiteboards")
      .update({ 
        content: latestElements, 
        updated_at: new Date().toISOString() 
      })
      .eq("id", currentBoard.id);

    setIsSaving(false);

    if (error) {
      console.error(error);
      alert("💾 保存失败：" + error.message);
    } else {
      alert("☁️ 已经成功将当前画作同步保存至云端数据库！");
      fetchBoards(userInfo, false); // 静默刷新左侧列表状态
    }
  };

  // 创建新私有白板
  const handleCreateBoard = async () => {
    if (!userInfo.isLoggedIn) return alert("请先切换为【已登录模式】");
    const title = prompt("请输入新白板名称：");
    if (!title) return;

    const newBoard = {
      id: crypto.randomUUID(),
      title: title,
      content: [],
      owner: userInfo.name,
      is_public: false
    };

    await supabase.from("whiteboards").insert([newBoard]);
    await fetchBoards(userInfo, false);
    handleSelectBoard(newBoard);
  };

  // 公开白板（转换为公共大厅协作画布）
  const handlePublish = async (e, board) => {
    e.stopPropagation();
    if (!userInfo.isLoggedIn) return alert("只有登录用户能公开白板");
    if (window.confirm(`确定要公开【${board.title}】并开启实时协作吗？`)) {
      await supabase.from("whiteboards").update({ is_public: true }).eq("id", board.id);
      const updated = { ...board, is_public: true };
      fetchBoards(userInfo, false);
      handleSelectBoard(updated);
    }
  };

  const toggleTestLogin = () => {
    const nextState = !userInfo.isLoggedIn;
    const mockUser = {
      name: nextState ? "用户_" + Math.floor(Math.random()*100) : `访客_${Math.floor(Math.random() * 100)}`,
      isLoggedIn: nextState
    };
    setUserInfo(mockUser);
    fetchBoards(mockUser, true);
  };

  return (
    <div style={styles.container}>
      {/* 侧边栏 */}
      <div style={styles.sidebar}>
        <div style={styles.userInfoCard}>
          <div style={styles.avatar}>{userInfo.name.charAt(0)}</div>
          <div>
            <div style={styles.userName}>{userInfo.name}</div>
            <div style={styles.userStatus}>
              <span style={{...styles.statusDot, backgroundColor: userInfo.isLoggedIn ? "#34A853" : "#9AA0A6"}}></span>
              {userInfo.isLoggedIn ? "已登录模式" : "访客模式"}
            </div>
          </div>
        </div>

        {/* 私人白板 */}
        <div style={styles.roomSection}>
          <div style={styles.sectionTitle}>
            <span>🔒 我的私人白板 (独享)</span>
            {userInfo.isLoggedIn && <button onClick={handleCreateBoard} style={styles.iconBtn}>+</button>}
          </div>
          <div style={styles.roomList}>
            {privateBoards.map((board) => (
              <div key={board.id} onClick={() => handleSelectBoard(board)}
                style={{...styles.roomItem, ...(currentBoard?.id === board.id ? styles.activeRoom : {})}}>
                <span style={styles.textEllipsis}>{board.title}</span>
                <button onClick={(e) => handlePublish(e, board)} style={styles.publishBtn}>公开</button>
              </div>
            ))}
            {privateBoards.length === 0 && <div style={styles.emptyText}>{userInfo.isLoggedIn ? "暂无，点击+号创建" : "登录后可创建私人白板"}</div>}
          </div>
        </div>

        {/* 公共大厅 */}
        <div style={{...styles.roomSection, marginTop: "20px"}}>
          <div style={styles.sectionTitle}><span>🌐 公共画布大厅 (多端联机)</span></div>
          <div style={styles.roomList}>
            {publicBoards.map((board) => (
              <div key={board.id} onClick={() => handleSelectBoard(board)}
                style={{...styles.roomItem, ...(currentBoard?.id === board.id ? styles.activeRoom : {})}}>
                <span style={styles.textEllipsis}>{board.title}</span>
                <span style={styles.ownerTag}>by {board.owner}</span>
              </div>
            ))}
            {publicBoards.length === 0 && <div style={styles.emptyText}>暂无公开大厅</div>}
          </div>
        </div>

        <button onClick={toggleTestLogin} style={styles.testLoginBtn}>
          ⚙️ 切换为: {userInfo.isLoggedIn ? "访客" : "已登录"} (模拟真实登录)
        </button>
      </div>

      {/* 主画布区 */}
      <div style={styles.main}>
        <div style={styles.header}>
          <div style={{display: "flex", alignItems: "center", gap: "12px"}}>
            <h2 style={styles.roomTitle}>{currentBoard?.title || "未选择白板"}</h2>
            {currentBoard && (
              <span style={currentBoard.is_public ? styles.badgePublic : styles.badgePrivate}>
                {currentBoard.is_public ? "P2P 实时房间连通中" : "本地离线画布"}
              </span>
            )}
          </div>
          
          <div style={{display: "flex", alignItems: "center", gap: "16px"}}>
            {/* 🌟 核心提效：手动同步保存到数据库按钮 */}
            {currentBoard && currentBoard.id !== "local_guest" && (
              <button 
                onClick={handleManualSave} 
                disabled={isSaving}
                style={{
                  ...styles.manualSaveBtn, 
                  backgroundColor: isSaving ? "#9AA0A6" : "#1a73e8"
                }}
              >
                {isSaving ? "正在同步..." : "☁️ 同步保存到云端"}
              </button>
            )}

            {currentBoard?.is_public && (
              <div style={styles.onlineContainer}>
                <span style={styles.onlineText}>在线看房:</span>
                {onlineUsers.map((u, idx) => (
                  <div key={idx} style={styles.onlineAvatar} title={u.name}>{u.name.charAt(0)}</div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={{ flex: 1, position: "relative", padding: "0 24px 24px 24px" }}>
          <div className="excalidraw-wrapper" style={{ width: "100%", height: "100%" }}>
            <Excalidraw 
              excalidrawRef={(api) => setExcalidrawAPI(api)} 
              onChange={handleOnChange}
              theme="light" 
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// 样式表
const styles = {
  container: { display: "flex", height: "100vh", backgroundColor: "var(--md-sys-color-surface)", padding: "16px", boxSizing: "border-box", gap: "16px" },
  sidebar: { width: "280px", backgroundColor: "var(--md-sys-color-surface-container)", borderRadius: "24px", display: "flex", flexDirection: "column", padding: "20px", boxSizing: "border-box" },
  userInfoCard: { display: "flex", alignItems: "center", gap: "16px", paddingBottom: "16px", borderBottom: `1px solid var(--md-sys-color-outline)` },
  avatar: { width: "40px", height: "40px", borderRadius: "20px", backgroundColor: "var(--md-sys-color-primary)", color: "#FFF", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px", fontWeight: "bold" },
  userName: { fontSize: "15px", fontWeight: "600" },
  userStatus: { fontSize: "12px", color: "#666", display: "flex", alignItems: "center", gap: "6px", marginTop: "2px" },
  statusDot: { width: "8px", height: "8px", borderRadius: "50%" },
  roomSection: { marginTop: "16px", flex: 1, overflowY: "auto" },
  sectionTitle: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "13px", fontWeight: "600", color: "#5F6368", marginBottom: "8px" },
  iconBtn: { background: "var(--md-sys-color-primary-container)", borderRadius: "50%", width: "24px", height: "24px", border: "none", fontSize: "16px", cursor: "pointer", color: "var(--md-sys-color-on-primary-container)", display: "flex", alignItems: "center", justifyContent: "center" },
  roomList: { display: "flex", flexDirection: "column", gap: "4px" },
  roomItem: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderRadius: "100px", cursor: "pointer", fontSize: "13px", color: "#3C4043" },
  activeRoom: { backgroundColor: "var(--md-sys-color-primary-container)", color: "var(--md-sys-color-on-primary-container)", fontWeight: "600" },
  textEllipsis: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "120px" },
  publishBtn: { fontSize: "11px", padding: "2px 8px", borderRadius: "10px", border: "1px solid var(--md-sys-color-primary)", backgroundColor: "transparent", color: "var(--md-sys-color-primary)", cursor: "pointer" },
  ownerTag: { fontSize: "11px", color: "#80868B" },
  emptyText: { fontSize: "12px", color: "#9AA0A6", textAlign: "center", padding: "10px 0" },
  testLoginBtn: { width: "100%", padding: "10px", borderRadius: "12px", backgroundColor: "#E65100", color: "white", border: "none", cursor: "pointer", fontWeight: "bold", marginTop: "auto", fontSize: "13px" },
  main: { flex: 1, backgroundColor: "var(--md-sys-color-surface-container)", borderRadius: "24px", display: "flex", flexDirection: "column" },
  header: { height: "64px", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 24px" },
  roomTitle: { margin: 0, fontSize: "20px", fontWeight: "400" },
  badgePrivate: { fontSize: "11px", padding: "2px 6px", backgroundColor: "#E8EAED", color: "#5F6368", borderRadius: "6px" },
  badgePublic: { fontSize: "11px", padding: "2px 6px", backgroundColor: "#CEEAD6", color: "#137333", borderRadius: "6px" },
  onlineContainer: { display: "flex", alignItems: "center", gap: "6px" },
  onlineText: { fontSize: "13px", color: "#5F6368" },
  onlineAvatar: { width: "28px", height: "28px", borderRadius: "14px", backgroundColor: "var(--md-sys-color-primary)", color: "#FFF", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: "bold", border: "2px solid #FFF", marginLeft: "-8px", boxShadow: "0 1px 2px rgba(0,0,0,0.15)" },
  manualSaveBtn: { padding: "8px 16px", color: "white", border: "none", borderRadius: "100px", cursor: "pointer", fontSize: "13px", fontWeight: "600", transition: "background-color 0.2s" }
};