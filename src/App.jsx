import { useEffect, useState, useRef } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import { createClient } from "@supabase/supabase-js";
import "@excalidraw/excalidraw/index.css";

// ⚠️ 替换为你自己的 Supabase 配置
const SUPABASE_URL = "https://mamubvgmcetepllznifl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HEeNPSqD75cWlnmZjcVHKA_Pw-OdL_A";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function App() {
  // === 状态管理 ===
  const [userInfo, setUserInfo] = useState({ name: "访客", isLoggedIn: false });
  const [privateBoards, setPrivateBoards] = useState([]);
  const [publicBoards, setPublicBoards] = useState([]);
  const [currentBoard, setCurrentBoard] = useState(null); // 当前选中的白板对象
  const [onlineUsers, setOnlineUsers] = useState([]);
  
  const [excalidrawAPI, setExcalidrawAPI] = useState(null);
  
  // === 性能与同步锁 ===
  const isReceiving = useRef(false);
  const lastBroadcastTime = useRef(0);
  const dbSaveTimer = useRef(null); // 数据库防抖保存定时器
  const isInitialLoad = useRef(true); // 防止刚加载白板时触发保存

  // 1. 初始化：获取用户信息 & 加载白板列表
  useEffect(() => {
    const initApp = async () => {
      let currentUser = { name: `访客_${Math.floor(Math.random() * 1000)}`, isLoggedIn: false };
      
      // 请求用户信息
      try {
        const res = await fetch("/api/userinfo");
        if (res.ok) {
          const data = await res.json();
          currentUser = { name: data.username, isLoggedIn: true };
        }
      } catch (error) {
        console.warn("未检测到登录状态，使用访客模式");
      }
      setUserInfo(currentUser);

      // 加载数据库里的白板
      fetchBoards(currentUser);
    };
    initApp();
  }, []);

  // 获取白板列表函数
  const fetchBoards = async (user) => {
    const { data, error } = await supabase.from("whiteboards").select("*").order('created_at', { ascending: false });
    if (error) return console.error("获取白板失败:", error);

    const publicList = [];
    const privateList = [];

    data.forEach(board => {
      if (board.is_public) {
        publicList.push(board);
      } else if (user.isLoggedIn && board.owner === user.name) {
        privateList.push(board);
      }
    });

    setPublicBoards(publicList);
    setPrivateBoards(privateList);

    // 默认选中第一个可用白板，或者给访客创建一个临时白板
    if (!currentBoard) {
      if (privateList.length > 0) setCurrentBoard(privateList[0]);
      else if (publicList.length > 0) setCurrentBoard(publicList[0]);
      else setCurrentBoard({ id: "local_guest", title: "临时白板(不保存)", is_public: false, owner: user.name, content: [] });
    }
  };

  // 2. 切换白板时的核心逻辑（加载内容 & 房间订阅）
  useEffect(() => {
    if (!excalidrawAPI || !currentBoard) return;

    // 清空当前画布，加载新白板内容
    isInitialLoad.current = true; // 锁定保存
    excalidrawAPI.updateScene({ elements: currentBoard.content || [] });
    setTimeout(() => { isInitialLoad.current = false; }, 500); // 0.5秒后解锁

    setOnlineUsers([]);

    // --- 如果是私有/离线白板，不开启 WebSocket 同步 ---
    if (!currentBoard.is_public) return;

    // --- 如果是公共白板，开启实时同步 ---
    const roomChannel = supabase.channel(`room-${currentBoard.id}`, {
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
        const users = Object.keys(presenceState).map(key => presenceState[key][0]);
        setOnlineUsers(users);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await roomChannel.track({ user: userInfo.name, joinedAt: new Date().toISOString() });
        }
      });

    return () => {
      supabase.removeChannel(roomChannel);
    };
  }, [excalidrawAPI, currentBoard?.id]); // 依赖项只监听 ID 变化，防止死循环

  // 3. 画布数据改变：广播 + 数据库自动保存
  const handleOnChange = (elements) => {
    if (isReceiving.current || isInitialLoad.current || !currentBoard) return;

    const now = Date.now();

    // A. 实时广播（仅限公开白板，高频节流）
    if (currentBoard.is_public && now - lastBroadcastTime.current > 100) {
      lastBroadcastTime.current = now;
      supabase.channel(`room-${currentBoard.id}`).send({
        type: "broadcast",
        event: "draw-sync",
        payload: { elements },
      });
    }

    // B. 数据库持久化（仅限登录用户 && 不是访客临时白板，低频防抖）
    if (userInfo.isLoggedIn && currentBoard.id !== "local_guest") {
      clearTimeout(dbSaveTimer.current);
      // 用户停笔 1.5 秒后，将最新 JSON 写入数据库
      dbSaveTimer.current = setTimeout(async () => {
        await supabase
          .from("whiteboards")
          .update({ content: elements, updated_at: new Date().toISOString() })
          .eq("id", currentBoard.id);
        console.log("云端保存成功！");
      }, 1500); 
    }
  };

  // 4. 创建新私有白板
  const handleCreateBoard = async () => {
    if (!userInfo.isLoggedIn) {
      alert("请先登录才能保存白板哦！");
      return;
    }
    const title = prompt("请输入新白板名称：");
    if (!title) return;

    const newBoard = {
      id: crypto.randomUUID(), // 生成唯一ID
      title: title,
      content: [],
      owner: userInfo.name,
      is_public: false
    };

    // 插入数据库
    await supabase.from("whiteboards").insert([newBoard]);
    fetchBoards(userInfo); // 刷新列表
    setCurrentBoard(newBoard);
  };

  // 5. 将私有白板公开
  const handlePublish = async (e, board) => {
    e.stopPropagation(); // 阻止点击事件冒泡
    if (window.confirm(`确定要公开【${board.title}】吗？公开后所有人都能进来画画。`)) {
      await supabase.from("whiteboards").update({ is_public: true }).eq("id", board.id);
      fetchBoards(userInfo); // 刷新列表
      
      // 更新当前状态
      if (currentBoard?.id === board.id) {
        setCurrentBoard({ ...board, is_public: true });
      }
    }
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
              {userInfo.isLoggedIn ? "已登录 (可云端保存)" : "访客 (不保存)"}
            </div>
          </div>
        </div>

        <div style={styles.roomSection}>
          <div style={styles.sectionTitle}>
            <span>我的私人白板 (离线)</span>
            {userInfo.isLoggedIn && <button onClick={handleCreateBoard} style={styles.iconBtn}>+</button>}
          </div>
          <div style={styles.roomList}>
            {privateBoards.length === 0 && <div style={styles.emptyText}>暂无私人白板</div>}
            {privateBoards.map((board) => (
              <div key={board.id} onClick={() => setCurrentBoard(board)}
                style={{...styles.roomItem, ...(currentBoard?.id === board.id ? styles.activeRoom : {})}}>
                <span style={styles.textEllipsis}>{board.title}</span>
                <button onClick={(e) => handlePublish(e, board)} style={styles.publishBtn}>公开</button>
              </div>
            ))}
          </div>
        </div>

        <div style={{...styles.roomSection, marginTop: "32px"}}>
          <div style={styles.sectionTitle}>
            <span>🌐 公共大厅 (实时同步)</span>
          </div>
          <div style={styles.roomList}>
             {publicBoards.length === 0 && <div style={styles.emptyText}>暂无公开白板</div>}
            {publicBoards.map((board) => (
              <div key={board.id} onClick={() => setCurrentBoard(board)}
                style={{...styles.roomItem, ...(currentBoard?.id === board.id ? styles.activeRoom : {})}}>
                <span style={styles.textEllipsis}>{board.title}</span>
                <span style={styles.ownerTag}>by {board.owner}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 主画布区 */}
      <div style={styles.main}>
        <div style={styles.header}>
          <div style={{display: "flex", alignItems: "center", gap: "12px"}}>
            <h2 style={styles.roomTitle}>{currentBoard?.title || "加载中..."}</h2>
            <span style={currentBoard?.is_public ? styles.badgePublic : styles.badgePrivate}>
              {currentBoard?.is_public ? "公开协作中" : "私密离线"}
            </span>
          </div>
          
          {currentBoard?.is_public && (
            <div style={styles.onlineContainer}>
              <span style={styles.onlineText}>在线:</span>
              {onlineUsers.map((user, idx) => (
                <div key={idx} style={styles.onlineAvatar} title={user.user}>
                  {user.user ? user.user.charAt(0) : "?"}
                </div>
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

// === 内联样式 (Google MD3 风格优化) ===
const styles = {
  container: { display: "flex", height: "100vh", backgroundColor: "var(--md-sys-color-surface)", padding: "16px", boxSizing: "border-box", gap: "16px" },
  sidebar: { width: "320px", backgroundColor: "var(--md-sys-color-surface-container)", borderRadius: "24px", display: "flex", flexDirection: "column", padding: "20px", boxSizing: "border-box" },
  userInfoCard: { display: "flex", alignItems: "center", gap: "16px", paddingBottom: "24px", borderBottom: `1px solid var(--md-sys-color-outline)` },
  avatar: { width: "48px", height: "48px", borderRadius: "24px", backgroundColor: "var(--md-sys-color-primary)", color: "#FFF", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px", fontWeight: "bold" },
  userName: { fontSize: "16px", fontWeight: "600" },
  userStatus: { fontSize: "12px", color: "#666", display: "flex", alignItems: "center", gap: "6px", marginTop: "4px" },
  statusDot: { width: "8px", height: "8px", borderRadius: "50%" },
  roomSection: { marginTop: "24px", flex: 1, overflowY: "auto" },
  sectionTitle: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "14px", fontWeight: "600", color: "#5F6368", marginBottom: "12px" },
  iconBtn: { background: "var(--md-sys-color-primary-container)", borderRadius: "50%", width: "28px", height: "28px", border: "none", fontSize: "20px", cursor: "pointer", color: "var(--md-sys-color-on-primary-container)", display: "flex", alignItems: "center", justifyContent: "center" },
  roomList: { display: "flex", flexDirection: "column", gap: "8px" },
  roomItem: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderRadius: "100px", cursor: "pointer", fontSize: "14px", color: "#3C4043", transition: "all 0.2s" },
  activeRoom: { backgroundColor: "var(--md-sys-color-primary-container)", color: "var(--md-sys-color-on-primary-container)", fontWeight: "600" },
  textEllipsis: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "140px" },
  publishBtn: { fontSize: "12px", padding: "4px 10px", borderRadius: "12px", border: "1px solid var(--md-sys-color-primary)", backgroundColor: "transparent", color: "var(--md-sys-color-primary)", cursor: "pointer" },
  ownerTag: { fontSize: "12px", color: "#80868B" },
  emptyText: { fontSize: "13px", color: "#9AA0A6", textAlign: "center", padding: "10px 0" },
  main: { flex: 1, backgroundColor: "var(--md-sys-color-surface-container)", borderRadius: "24px", display: "flex", flexDirection: "column" },
  header: { height: "72px", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 24px" },
  roomTitle: { margin: 0, fontSize: "22px", fontWeight: "400" },
  badgePrivate: { fontSize: "12px", padding: "4px 8px", backgroundColor: "#E8EAED", color: "#5F6368", borderRadius: "8px", fontWeight: "bold" },
  badgePublic: { fontSize: "12px", padding: "4px 8px", backgroundColor: "#CEEAD6", color: "#137333", borderRadius: "8px", fontWeight: "bold" },
  onlineContainer: { display: "flex", alignItems: "center", gap: "8px" },
  onlineText: { fontSize: "14px", color: "#5F6368", marginRight: "8px" },
  onlineAvatar: { width: "32px", height: "32px", borderRadius: "16px", backgroundColor: "var(--md-sys-color-primary)", color: "#FFF", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", fontWeight: "bold", border: "2px solid #FFF", marginLeft: "-12px", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }
};