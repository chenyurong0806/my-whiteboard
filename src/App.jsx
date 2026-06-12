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
  const [userInfo, setUserInfo] = useState({ name: "未登录", isLoggedIn: false });
  const [rooms, setRooms] = useState(["默认白板", "头脑风暴", "UI设计草图"]);
  const [currentRoom, setCurrentRoom] = useState("默认白板");
  const [onlineUsers, setOnlineUsers] = useState([]);
  
  const [excalidrawAPI, setExcalidrawAPI] = useState(null);
  
  // === 性能与同步锁 ===
  const isReceiving = useRef(false);
  const lastSendTime = useRef(0);

  // 1. 获取当前用户信息
  useEffect(() => {
    const fetchUser = async () => {
      try {
        const res = await fetch("/api/userinfo");
        if (res.ok) {
          const data = await res.json();
          setUserInfo({ name: data.username || "神秘访客", isLoggedIn: true });
        } else {
          // 接口不通或未登录
          setUserInfo({ name: "未登录", isLoggedIn: false });
        }
      } catch (error) {
        console.warn("未能获取用户信息，使用默认访客身份。");
        // 为了方便你本地测试，即使 fetch 报错也给个随机名字
        setUserInfo({ name: `访客_${Math.floor(Math.random() * 1000)}`, isLoggedIn: false });
      }
    };
    fetchUser();
  }, []);

  // 2. 房间切换与实时同步逻辑 (核心优化)
  useEffect(() => {
    if (!excalidrawAPI) return;

    // 清空画布准备迎接新房间数据
    excalidrawAPI.updateScene({ elements: [] });

    // 创建当前房间的专属频道
    const roomChannel = supabase.channel(`room-${currentRoom}`, {
      config: { presence: { key: userInfo.name } }, // 将当前用户名注册到 Presence
    });

    roomChannel
      // --- 监听别人画画 ---
      .on("broadcast", { event: "draw-sync" }, ({ payload }) => {
        isReceiving.current = true;
        excalidrawAPI.updateScene({ elements: payload.elements });
        setTimeout(() => { isReceiving.current = false; }, 50);
      })
      // --- 监听人员进出 (Presence) ---
      .on("presence", { event: "sync" }, () => {
        const presenceState = roomChannel.presenceState();
        // 提取所有在线用户的名字并去重
        const users = Object.keys(presenceState).map(key => presenceState[key][0]);
        setOnlineUsers(users);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          // 订阅成功后，向房间广播自己的存在
          await roomChannel.track({ user: userInfo.name, joinedAt: new Date().toISOString() });
        }
      });

    // 离开房间时清理频道
    return () => {
      supabase.removeChannel(roomChannel);
    };
  }, [excalidrawAPI, currentRoom, userInfo.name]);

  // 3. 画布改变时发送数据 (带节流优化)
  const handleOnChange = (elements) => {
    if (isReceiving.current) return;

    // 节流优化：限制发送频率，每 100 毫秒最多发一次，避免冲垮网络
    const now = Date.now();
    if (now - lastSendTime.current < 100) return;
    lastSendTime.current = now;

    supabase.channel(`room-${currentRoom}`).send({
      type: "broadcast",
      event: "draw-sync",
      payload: { elements },
    });
  };

  // 4. 创建新白板房间
  const handleCreateRoom = () => {
    const roomName = prompt("请输入新白板名称：");
    if (roomName && !rooms.includes(roomName)) {
      setRooms([...rooms, roomName]);
      setCurrentRoom(roomName);
    }
  };

  // === UI 渲染 (Google MD3 风格) ===
  return (
    <div style={styles.container}>
      {/* 左侧侧边栏 */}
      <div style={styles.sidebar}>
        <div style={styles.userInfoCard}>
          <div style={styles.avatar}>{userInfo.name.charAt(0)}</div>
          <div>
            <div style={styles.userName}>{userInfo.name}</div>
            <div style={styles.userStatus}>
              <span style={styles.statusDot}></span>
              {userInfo.isLoggedIn ? "已连接" : "访客模式"}
            </div>
          </div>
        </div>

        <div style={styles.roomSection}>
          <div style={styles.sectionTitle}>
            <span>我的白板</span>
            <button onClick={handleCreateRoom} style={styles.iconBtn}>+</button>
          </div>
          <div style={styles.roomList}>
            {rooms.map((room) => (
              <div 
                key={room} 
                onClick={() => setCurrentRoom(room)}
                style={{
                  ...styles.roomItem,
                  ...(currentRoom === room ? styles.activeRoom : {})
                }}
              >
                {room}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 右侧主体内容 */}
      <div style={styles.main}>
        {/* 顶部工具栏（显示在线人数） */}
        <div style={styles.header}>
          <h2 style={styles.roomTitle}>{currentRoom}</h2>
          <div style={styles.onlineContainer}>
            <span style={styles.onlineText}>当前在线:</span>
            {onlineUsers.map((user, idx) => (
              <div key={idx} style={styles.onlineAvatar} title={user.user}>
                {user.user ? user.user.charAt(0) : "?"}
              </div>
            ))}
          </div>
        </div>

        {/* 画板区域 */}
        <div style={{ flex: 1, position: "relative", padding: "0 24px 24px 24px" }}>
          <div className="excalidraw-wrapper" style={{ width: "100%", height: "100%" }}>
            <Excalidraw 
              excalidrawRef={(api) => setExcalidrawAPI(api)} 
              onChange={handleOnChange}
              // 强制使用亮色主题配合我们设计的界面
              theme="light" 
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// === 内联样式 (模拟 Material Design 3) ===
const styles = {
  container: { display: "flex", height: "100vh", backgroundColor: "var(--md-sys-color-surface)", padding: "16px", boxSizing: "border-box", gap: "16px" },
  sidebar: { width: "280px", backgroundColor: "var(--md-sys-color-surface-container)", borderRadius: "24px", display: "flex", flexDirection: "column", padding: "20px", boxSizing: "border-box" },
  userInfoCard: { display: "flex", alignItems: "center", gap: "16px", paddingBottom: "24px", borderBottom: `1px solid var(--md-sys-color-outline)` },
  avatar: { width: "48px", height: "48px", borderRadius: "24px", backgroundColor: "var(--md-sys-color-primary-container)", color: "var(--md-sys-color-on-primary-container)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px", fontWeight: "bold" },
  userName: { fontSize: "16px", fontWeight: "600" },
  userStatus: { fontSize: "12px", color: "#666", display: "flex", alignItems: "center", gap: "6px", marginTop: "4px" },
  statusDot: { width: "8px", height: "8px", backgroundColor: "#34A853", borderRadius: "50%" },
  roomSection: { marginTop: "24px", flex: 1, overflowY: "auto" },
  sectionTitle: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "14px", fontWeight: "600", color: "#5F6368", marginBottom: "12px" },
  iconBtn: { background: "none", border: "none", fontSize: "24px", cursor: "pointer", color: "var(--md-sys-color-primary)" },
  roomList: { display: "flex", flexDirection: "column", gap: "8px" },
  roomItem: { padding: "12px 16px", borderRadius: "100px", cursor: "pointer", fontSize: "14px", color: "#3C4043", transition: "all 0.2s" },
  activeRoom: { backgroundColor: "var(--md-sys-color-primary-container)", color: "var(--md-sys-color-on-primary-container)", fontWeight: "600" },
  main: { flex: 1, backgroundColor: "var(--md-sys-color-surface-container)", borderRadius: "24px", display: "flex", flexDirection: "column" },
  header: { height: "72px", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 24px" },
  roomTitle: { margin: 0, fontSize: "22px", fontWeight: "400" },
  onlineContainer: { display: "flex", alignItems: "center", gap: "8px" },
  onlineText: { fontSize: "14px", color: "#5F6368", marginRight: "8px" },
  onlineAvatar: { width: "32px", height: "32px", borderRadius: "16px", backgroundColor: "var(--md-sys-color-primary)", color: "#FFF", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", fontWeight: "bold", border: "2px solid #FFF", marginLeft: "-12px", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }
};