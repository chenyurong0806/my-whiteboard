import { useEffect, useState, useRef } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import { createClient } from "@supabase/supabase-js";
import "@excalidraw/excalidraw/index.css";

const SUPABASE_URL = "https://mamubvgmcetepllznifl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HEeNPSqD75cWlnmZjcVHKA_Pw-OdL_A";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function App() {
  // === 状态管理 ===
  const [userInfo, setUserInfo] = useState({ name: "访客", isLoggedIn: false });
  const [privateBoards, setPrivateBoards] = useState([]);
  const [publicBoards, setPublicBoards] = useState([]);
  const [currentBoard, setCurrentBoard] = useState(null); 
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [excalidrawAPI, setExcalidrawAPI] = useState(null);
  
  // === 性能与同步锁 ===
  const isReceiving = useRef(false);
  const lastBroadcastTime = useRef(0);
  const dbSaveTimer = useRef(null); 
  const isInitialLoading = useRef(false); // 精准控制初始化锁
  const lastLoadedId = useRef(null);      // 记录最后一次加载的白板ID

  // 1. 初始化：获取用户信息 & 加载白板列表
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
        console.warn("未检测到真实登录接口，默认开启访客模式（可在下方手动切换测试）");
      }
      setUserInfo(currentUser);
      fetchBoards(currentUser);
    };
    initApp();
  }, []);

  // 核心：从数据库读取白板
  const fetchBoards = async (user) => {
    const { data, error } = await supabase.from("whiteboards").select("*").order('created_at', { ascending: false });
    if (error) return console.error(error);

    const publicList = [];
    const privateList = [];
    data.forEach(board => {
      if (board.is_public) publicList.push(board);
      else if (user.isLoggedIn && board.owner === user.name) privateList.push(board);
    });

    setPublicBoards(publicList);
    setPrivateBoards(privateList);

    // 如果还没有选择任何白板，进行默认选择
    if (!currentBoard) {
      if (privateList.length > 0) setCurrentBoard(privateList[0]);
      else if (publicList.length > 0) setCurrentBoard(publicList[0]);
      else setCurrentBoard({ id: "local_guest", title: "临时白板(不保存)", is_public: false, owner: user.name, content: [] });
    }
  };

  // 2. 核心修复：切换白板/公开白板时，重新触发此效应
  useEffect(() => {
    if (!excalidrawAPI || !currentBoard) return;

    // 【修复刷新消失】如果换了新白板，必须强制加锁，并清空上一次的保存定时器
    if (lastLoadedId.current !== currentBoard.id) {
      clearTimeout(dbSaveTimer.current);
      isInitialLoading.current = true;
      lastLoadedId.current = currentBoard.id;
      
      excalidrawAPI.updateScene({ elements: currentBoard.content || [] });
      
      // 确保 Excalidraw 渲染完成后再解锁
      setTimeout(() => { isInitialLoading.current = false; }, 400);
    }

    setOnlineUsers([]);

    // 如果不是公开白板，不建立实时联机通道
    if (!currentBoard.is_public) return;

    // 【修复不同步】现在开启实时通道
    const channelName = `room-${currentBoard.id}`;
    const roomChannel = supabase.channel(channelName, {
      config: { presence: { key: userInfo.name } },
    });

    roomChannel
      .on("broadcast", { event: "draw-sync" }, ({ payload }) => {
        isReceiving.current = true;
        excalidrawAPI.updateScene({ elements: payload.elements });
        setTimeout(() => { isReceiving.current = false; }, 50);
      })
      .on("presence", { event: "sync" }, () => {
        const presenceState = roomChannel.presenceState();
        const users = Object.keys(presenceState).map(key => ({ name: key }));
        setOnlineUsers(users);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await roomChannel.track({ user: userInfo.name });
        }
      });

    return () => {
      supabase.removeChannel(roomChannel);
    };
    // 💡 关键修复：把 currentBoard.is_public 补进依赖项，状态一变，立刻重连 WebSocket！
  }, [excalidrawAPI, currentBoard?.id, currentBoard?.is_public, userInfo.name]);

  // 3. 画布改变监听
  const handleOnChange = (elements) => {
    // 如果正在接收别人的数据，或者处于初始化加载中，绝对不向外触发保存/广播
    if (isReceiving.current || isInitialLoading.current || !currentBoard) return;

    const now = Date.now();

    // A. 广播逻辑
    if (currentBoard.is_public && now - lastBroadcastTime.current > 80) {
      lastBroadcastTime.current = now;
      supabase.channel(`room-${currentBoard.id}`).send({
        type: "broadcast",
        event: "draw-sync",
        payload: { elements },
      });
    }

    // B. 保存逻辑：只有登录用户且不是本地临时房，才存入数据库
    if (userInfo.isLoggedIn && currentBoard.id !== "local_guest") {
      clearTimeout(dbSaveTimer.current);
      
      // 并在内存中实时同步更新当前白板对象的数据，防止切换时拿到旧数据
      currentBoard.content = elements; 

      dbSaveTimer.current = setTimeout(async () => {
        await supabase
          .from("whiteboards")
          .update({ content: elements, updated_at: new Date().toISOString() })
          .eq("id", currentBoard.id);
        console.log("👉 云端保存成功！");
      }, 1000); // 停笔 1 秒后自动保存
    }
  };

  // 4. 创建新私有白板
  const handleCreateBoard = async () => {
    if (!userInfo.isLoggedIn) return alert("请先在左下角切换为【已登录模式】测试！");
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
    await fetchBoards(userInfo);
    setCurrentBoard(newBoard);
  };

  // 5. 公开白板
  const handlePublish = async (e, board) => {
    e.stopPropagation();
    if (!userInfo.isLoggedIn) return alert("只有登录用户能公开白板");
    if (window.confirm(`确定要公开【${board.title}】吗？`)) {
      await supabase.from("whiteboards").update({ is_public: true }).eq("id", board.id);
      
      // 关键：同时更新本地状态，触发 useEffect 重连
      const updated = { ...board, is_public: true };
      setCurrentBoard(updated);
      fetchBoards(userInfo);
    }
  };

  // 🛠️ 专为你准备的：本地快速模拟登录工具
  const toggleTestLogin = () => {
    const nextState = !userInfo.isLoggedIn;
    const mockUser = {
      name: nextState ? "小明_测试员" : `访客_${Math.floor(Math.random() * 100)}`,
      isLoggedIn: nextState
    };
    setUserInfo(mockUser);
    fetchBoards(mockUser);
    setCurrentBoard(null); // 重置以便重新选择
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

        {/* 私人列表 */}
        <div style={styles.roomSection}>
          <div style={styles.sectionTitle}>
            <span>🔒 我的私人白板</span>
            {userInfo.isLoggedIn && <button onClick={handleCreateBoard} style={styles.iconBtn}>+</button>}
          </div>
          <div style={styles.roomList}>
            {privateBoards.map((board) => (
              <div key={board.id} onClick={() => setCurrentBoard(board)}
                style={{...styles.roomItem, ...(currentBoard?.id === board.id ? styles.activeRoom : {})}}>
                <span style={styles.textEllipsis}>{board.title}</span>
                <button onClick={(e) => handlePublish(e, board)} style={styles.publishBtn}>公开</button>
              </div>
            ))}
            {privateBoards.length === 0 && <div style={styles.emptyText}>{userInfo.isLoggedIn ? "暂无，点击右上角+创建" : "登录后可创建私人白板"}</div>}
          </div>
        </div>

        {/* 公共列表 */}
        <div style={{...styles.roomSection, marginTop: "20px"}}>
          <div style={styles.sectionTitle}><span>🌐 公共大厅 (协作)</span></div>
          <div style={styles.roomList}>
            {publicBoards.map((board) => (
              <div key={board.id} onClick={() => setCurrentBoard(board)}
                style={{...styles.roomItem, ...(currentBoard?.id === board.id ? styles.activeRoom : {})}}>
                <span style={styles.textEllipsis}>{board.title}</span>
                <span style={styles.ownerTag}>by {board.owner}</span>
              </div>
            ))}
            {publicBoards.length === 0 && <div style={styles.emptyText}>暂无公开白板</div>}
          </div>
        </div>

        {/* 测试登录按钮 */}
        <button onClick={toggleTestLogin} style={styles.testLoginBtn}>
          ⚙️ 切换为: {userInfo.isLoggedIn ? "访客" : "已登录"} (测试用)
        </button>
      </div>

      {/* 主画布 */}
      <div style={styles.main}>
        <div style={styles.header}>
          <div style={{display: "flex", alignItems: "center", gap: "12px"}}>
            <h2 style={styles.roomTitle}>{currentBoard?.title || "未选择白板"}</h2>
            {currentBoard && (
              <span style={currentBoard.is_public ? styles.badgePublic : styles.badgePrivate}>
                {currentBoard.is_public ? "公开同步中" : "离线私密"}
              </span>
            )}
          </div>
          
          {currentBoard?.is_public && (
            <div style={styles.onlineContainer}>
              <span style={styles.onlineText}>在线:</span>
              {onlineUsers.map((u, idx) => (
                <div key={idx} style={styles.onlineAvatar} title={u.name}>{u.name.charAt(0)}</div>
              ))}
            </div>
          )}
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

// 补充样式
const styles = {
  container: { display: "flex", height: "100vh", backgroundColor: "var(--md-sys-color-surface)", padding: "16px", boxSizing: "border-box", gap: "16px" },
  sidebar: { width: "280px", backgroundColor: "var(--md-sys-color-surface-container)", borderRadius: "24px", display: "flex", flexDirection: "column", padding: "20px", boxSizing: "border-box", position: "relative" },
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
  onlineAvatar: { width: "28px", height: "28px", borderRadius: "14px", backgroundColor: "var(--md-sys-color-primary)", color: "#FFF", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: "bold", border: "2px solid #FFF", marginLeft: "-8px", boxShadow: "0 1px 2px rgba(0,0,0,0.15)" }
};