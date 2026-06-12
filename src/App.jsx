import { useEffect, useState, useRef } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import { createClient } from "@supabase/supabase-js";
import "@excalidraw/excalidraw/index.css";

// ⚠️ 替换为你自己的 Supabase 配置
const SUPABASE_URL = "你的_SUPABASE_URL";
const SUPABASE_ANON_KEY = "你的_SUPABASE_ANON_KEY";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function App() {
  // === 状态管理 ===
  const [userInfo, setUserInfo] = useState({ name: "访客", isLoggedIn: false });
  const [currentRoom, setCurrentRoom] = useState(null); // 当前房间ID，null 表示本地离线白板
  const [roomTitle, setRoomTitle] = useState("本地离线画布");
  const [isPublic, setIsPublic] = useState(false); // 当前白板是否公开
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [excalidrawAPI, setExcalidrawAPI] = useState(null);

  // === 同步锁与节流 ===
  const isReceiving = useRef(false);
  const lastSendTime = useRef(0);

  // 1. 初始化：获取用户信息 + 解析 URL 里的分享加入链接
  useEffect(() => {
    const initApp = async () => {
      // 检查是否是通过分享链接进来的 (例如: ?room=xxxx)
      const urlParams = new URLSearchParams(window.location.search);
      const roomIdFromUrl = urlParams.get("room");

      // 请求后端获取用户信息
      try {
        const res = await fetch("/api/userinfo");
        if (res.ok) {
          const data = await res.json();
          setUserInfo({ name: data.username || "神秘会员", isLoggedIn: true });
        }
      } catch (e) {
        // Mock 模式：如果没有 API，根据 URL 是否带房间号决定身份
        setUserInfo({
          name: roomIdFromUrl ? `协同访客_${Math.floor(Math.random()*100)}` : "本地访客",
          isLoggedIn: !roomIdFromUrl // 没带房间号默认当成未登录访客
        });
      }

      // 如果有分享链接，直接进入该房间
      if (roomIdFromUrl) {
        setCurrentRoom(roomIdFromUrl);
        setIsPublic(true);
        fetchRoomData(roomIdFromUrl);
      } else {
        // 否则加载本地离线缓存
        loadLocalData();
      }
    };
    initApp();
  }, [excalidrawAPI]);

  // 2. 从数据库加载公开白板的历史数据
  const fetchRoomData = async (roomId) => {
    const { data, error } = await supabase
      .from("whiteboards") // ⚠️ 需要在 Supabase 建这张表，建表语句在下方
      .select("*")
      .eq("id", roomId)
      .single();

    if (data && excalidrawAPI) {
      setRoomTitle(data.title);
      isReceiving.current = true;
      excalidrawAPI.updateScene({ elements: data.content });
      setTimeout(() => { isReceiving.current = false; }, 50);
    }
  };

  // 加载本地 LocalStorage 数据
  const loadLocalData = () => {
    const localData = localStorage.getItem("offline_whiteboard");
    if (localData && excalidrawAPI) {
      excalidrawAPI.updateScene({ elements: JSON.parse(localData) });
    }
  };

  // 3. 实时多人协同频道监听 (只有公开房间才启用)
  useEffect(() => {
    if (!excalidrawAPI || !currentRoom) return;

    const roomChannel = supabase.channel(`room-${currentRoom}`, {
      config: { presence: { key: userInfo.name } },
    });

    roomChannel
      .on("broadcast", { event: "draw-sync" }, ({ payload }) => {
        isReceiving.current = true;
        excalidrawAPI.updateScene({ elements: payload.elements });
        setTimeout(() => { isReceiving.current = false; }, 50);
      })
      .on("presence", { event: "sync" }, () => {
        const state = roomChannel.presenceState();
        const users = Object.keys(state).map(key => state[key][0]);
        setOnlineUsers(users);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await roomChannel.track({ user: userInfo.name });
        }
      });

    return () => { supabase.removeChannel(roomChannel); };
  }, [excalidrawAPI, currentRoom, userInfo.name]);

  // 4. 画布变更处理（核心路由：离线 vs 云端）
  const handleOnChange = async (elements) => {
    if (isReceiving.current || !excalidrawAPI) return;

    // 路由 A：如果是离线模式，只存本地，不发网络
    if (!currentRoom) {
      localStorage.setItem("offline_whiteboard", JSON.stringify(elements));
      return;
    }

    // 路由 B：如果是公开房间，执行节流广播 + 登录用户异步持久化
    const now = Date.now();
    if (now - lastSendTime.current < 80) return; // 80ms 节流
    lastSendTime.current = now;

    // P2P 实时广播（让房间里其他人立刻看到）
    supabase.channel(`room-${currentRoom}`).send({
      type: "broadcast",
      event: "draw-sync",
      payload: { elements },
    });

    // 只有登录了的房主，才把数据持久化存进数据库中
    if (userInfo.isLoggedIn) {
      await supabase
        .from("whiteboards")
        .update({ content: elements, updated_at: new Date() })
        .eq("id", currentRoom);
    }
  };

  // 5. 将当前离线白板“发布/公开”
  const handlePublish = async () => {
    if (!userInfo.isLoggedIn) {
      alert("🔒 请先登录！访客创建的白板无法上传至云端保存。");
      return;
    }

    const title = prompt("为你的公开白板起个名字：", "未命名协同看板");
    if (!title) return;

    const elements = excalidrawAPI.getSceneElements();
    const randomRoomId = Math.random().toString(36).substring(2, 11); // 生成随机房间ID

    // 往 Supabase 数据库插入新房间数据
    const { error } = await supabase.from("whiteboards").insert([
      { id: randomRoomId, title: title, content: elements, owner: userInfo.name }
    ]);

    if (!error) {
      setCurrentRoom(randomRoomId);
      setRoomTitle(title);
      setIsPublic(true);
      // 在当前网址后面加上参数，方便用户复制分享
      const shareUrl = `${window.location.origin}${window.location.pathname}?room=${randomRoomId}`;
      window.history.pushState({}, "", shareUrl);
      alert(`🎉 公开成功！快把浏览器地址栏的链接发给好友一起作画吧！\n链接：${shareUrl}`);
    } else {
      alert("发布失败，请检查数据库配置。");
    }
  };

  // 6. 返回离线单机模式
  const handleGoOffline = () => {
    window.history.pushState({}, "", window.location.pathname); // 清除 URL 参数
    setCurrentRoom(null);
    setRoomTitle("本地离线画布");
    setIsPublic(false);
    setOnlineUsers([]);
    loadLocalData();
  };

  return (
    <div style={styles.container}>
      {/* 现代化轻量侧边栏 */}
      <div style={styles.sidebar}>
        <div style={styles.userInfo}>
          <div style={styles.avatar}>{userInfo.name.charAt(0)}</div>
          <div>
            <div style={styles.userName}>{userInfo.name}</div>
            <div style={styles.status}>{userInfo.isLoggedIn ? "🟢 成员" : "⚪ 访客"}</div>
          </div>
        </div>

        <div style={styles.menuSection}>
          <div style={styles.currentMode}>
            当前状态：
            <span style={{ color: isPublic ? "#E65100" : "#666", fontWeight: "bold" }}>
              {isPublic ? "🌐 已公开联机" : "📴 离线单机"}
            </span>
          </div>

          {!isPublic ? (
            <button onClick={handlePublish} style={styles.primaryBtn}>
              🚀 将此白板公开分享
            </button>
          ) : (
            <button onClick={handleGoOffline} style={styles.secondaryBtn}>
              🔌 切回我的离线画布
            </button>
          )}
        </div>
        
        {isPublic && (
          <div style={styles.onlineSection}>
            <div style={{fontSize:"13px", color:"#5F6368", marginBottom:"8px"}}>房间在线：({onlineUsers.length}人)</div>
            <div style={{display:"flex", gap:"4px", flexWrap:"wrap"}}>
              {onlineUsers.map((u, i) => (
                <div key={i} style={styles.userChip}>{u.user}</div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 画板主区域 */}
      <div style={styles.main}>
        <div style={styles.header}>
          <h2 style={styles.title}>{roomTitle}</h2>
          {isPublic && (
            <button 
              onClick={() => {
                navigator.clipboard.writeText(window.location.href);
                alert("链接已复制到剪贴板！");
              }}
              style={styles.shareBtn}
            >
              🔗 复制分享链接
            </button>
          )}
        </div>
        <div style={{ flex: 1, padding: "0 20px 20px 20px", position: "relative" }}>
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

// === 样式 (继续保持 MD3 橙色调) ===
const styles = {
  container: { display: "flex", height: "100vh", backgroundColor: "#F8F9FA", padding: "12px", boxSizing: "border-box", gap: "12px" },
  sidebar: { width: "260px", backgroundColor: "#FFF", borderRadius: "20px", padding: "20px", display: "flex", flexDirection: "column", gap: "24px", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" },
  userInfo: { display: "flex", alignItems: "center", gap: "12px" },
  avatar: { width: "40px", height: "40px", borderRadius: "50%", backgroundColor: "#FFCC80", color: "#4E1800", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "bold" },
  userName: { fontSize: "14px", fontWeight: "600" },
  status: { fontSize: "11px", color: "#888", marginTop: "2px" },
  menuSection: { display: "flex", flexDirection: "column", gap: "12px" },
  currentMode: { fontSize: "13px", color: "#3C4043" },
  primaryBtn: { backgroundColor: "#E65100", color: "#FFF", border: "none", padding: "12px", borderRadius: "100px", cursor: "pointer", fontWeight: "600", fontSize: "13px", transition: "all 0.2s" },
  secondaryBtn: { backgroundColor: "#F1F3F4", color: "#3C4043", border: "none", padding: "12px", borderRadius: "100px", cursor: "pointer", fontWeight: "600", fontSize: "13px" },
  main: { flex: 1, backgroundColor: "#FFF", borderRadius: "20px", display: "flex", flexDirection: "column" },
  header: { height: "64px", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 24px" },
  title: { margin: 0, fontSize: "18px", fontWeight: "500", color: "#1F1F1F" },
  shareBtn: { backgroundColor: "#FFF8F5", color: "#E65100", border: "1px solid #FFCC80", padding: "6px 16px", borderRadius: "100px", fontSize: "12px", cursor: "pointer", fontWeight: "600" },
  onlineSection: { borderTop: "1px solid #F1F3F4", paddingTop: "16px" },
  userChip: { backgroundColor: "#F1F3F4", padding: "4px 10px", borderRadius: "100px", fontSize: "11px", color: "#3C4043" }
};