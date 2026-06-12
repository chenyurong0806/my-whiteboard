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
  const [apiReady, setApiReady] = useState(false); // 核心：画布 API 准备就绪状态
  const [isSaving, setIsSaving] = useState(false);

  // === 严格状态控制 refs ===
  const excalidrawAPIRef = useRef(null); // 使用稳定的 Ref 存储 API，避免触发频繁重绘
  const isReceiving = useRef(false);
  const isInitialLoading = useRef(false); // 确定性生命周期加载锁
  const lastBroadcastTime = useRef(0);
  const lastVersionSum = useRef(0); // 核心：版本特征锁指针
  const channelRef = useRef(null);

  // 1. 初始化用户和列表
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
      fetchBoards(currentUser, true);
    };
    initApp();
  }, []);

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

    if (autoSelect) {
      if (privateList.length > 0) setCurrentBoard(privateList[0]);
      else if (publicList.length > 0) setCurrentBoard(publicList[0]);
      else setCurrentBoard({ id: "local_guest", title: "临时白板(不保存)", is_public: false, owner: user.name, content: [] });
    }
  };

  // 2. 🛡️ 【钢铁防线一】严格的数据反渲染逻辑（当白板切换或 API 准备就绪时触发）
  useEffect(() => {
    const api = excalidrawAPIRef.current;
    if (!api || !currentBoard) return;

    console.log("🔄 正在将云端数据安全注入画布，白板ID:", currentBoard.id);

    // 兼容判定：容错处理 Supabase 中储存为 string 或者是标准的 jsonb 格式
    let elements = [];
    if (currentBoard.content) {
      try {
        elements = typeof currentBoard.content === "string" 
          ? JSON.parse(currentBoard.content) 
          : currentBoard.content;
      } catch (e) {
        console.error("解析画作内容数据失败:", e);
      }
    }

    if (!Array.isArray(elements)) elements = [];

    // 🌟 1. 开启绝对初始化加载锁
    isInitialLoading.current = true;
    
    // 🌟 2. 提前计算出即将载入图形的版本特征总和
    const loadedSum = elements.reduce((sum, el) => sum + el.version, 0);
    lastVersionSum.current = loadedSum;

    // 🌟 3. 强行灌入画布
    api.updateScene({ elements: elements });
    
    console.log("等待 Excalidraw 内部状态消费，目标特征和为:", loadedSum);
  }, [currentBoard?.id, apiReady]);

  // 3. 📡 【钢铁防线二】请求-响应式实时联机大厅（完全不污染数据库）
  useEffect(() => {
    if (!excalidrawAPIRef.current || !currentBoard) return;

    setOnlineUsers([]);
    if (!currentBoard.is_public) return;

    const channelName = `room-${currentBoard.id}`;
    const roomChannel = supabase.channel(channelName, {
      config: { presence: { key: userInfo.name } },
    });

    channelRef.current = roomChannel;

    roomChannel
      // 🌟 A 监听：收到新进房用户的同步请求，老兵把当前最完美的画布“甩”给新兵
      .on("broadcast", { event: "request-canvas" }, ({ payload }) => {
        if (payload?.sender !== userInfo.name && !isInitialLoading.current && excalidrawAPIRef.current) {
          console.log(`接收到新用户 [${payload?.sender}] 的求助，正在定向单向投喂画布...`);
          roomChannel.send({
            type: "broadcast",
            event: "draw-sync",
            payload: { elements: excalidrawAPIRef.current.getSceneElements() },
          });
        }
      })
      // B 监听：接收实时的画笔轨迹
      .on("broadcast", { event: "draw-sync" }, ({ payload }) => {
        isReceiving.current = true;
        const receivedElements = payload.elements || [];
        
        // 收到广播数据时，立刻同步本地的版本锁，严防回弹
        lastVersionSum.current = receivedElements.reduce((sum, el) => sum + el.version, 0);
        excalidrawAPIRef.current?.updateScene({ elements: receivedElements });
        
        if (currentBoard) currentBoard.content = receivedElements; // 内存缓存

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
          // 🌟 C 投路问标：新用户进房成功订阅后，在房间里大喊一声求数据，拒绝盲目广播空画布
          roomChannel.send({
            type: "broadcast",
            event: "request-canvas",
            payload: { sender: userInfo.name }
          });
        }
      });

    return () => {
      supabase.removeChannel(roomChannel);
      channelRef.current = null;
    };
  }, [currentBoard?.id, currentBoard?.is_public, userInfo.name]);

  // 4. 🎛️ 【核心中枢】画布唯一 onChange 判定状态机
  const handleOnChange = (elements) => {
    const currentSum = elements.reduce((sum, el) => sum + el.version, 0);

    // 🌟【确定性解密锁】核心突破点
    if (isInitialLoading.current) {
      // 只有当 Excalidraw 内部真正把刚才注入的图形渲染上屏，并吐出匹配的版本特征和时，锁才精准解开！
      if (currentSum === lastVersionSum.current) {
        isInitialLoading.current = false;
        console.log("🎯 确定性比对一致！组件已渲染成功，加载锁精准解除。");
      }
      return; // 初始化中，一律封锁，不允许往外传递任何数据
    }

    if (isReceiving.current) {
      lastVersionSum.current = currentSum;
      return;
    }

    // 拦截无意义的高频画布缩放、视口平移
    if (currentSum === lastVersionSum.current) return;
    
    // 穿透拦截，确认是用户本人在作画
    lastVersionSum.current = currentSum;
    if (currentBoard) currentBoard.content = elements; // 刷新内存

    // 纯前端 P2P 瞬间高频广播
    if (currentBoard?.is_public && channelRef.current) {
      const now = Date.now();
      if (now - lastBroadcastTime.current > 60) {
        lastBroadcastTime.current = now;
        channelRef.current.send({
          type: "broadcast",
          event: "draw-sync",
          payload: { elements },
        });
      }
    }
  };

  // 5. 手动同步归档到数据库锁
  const handleManualSave = async () => {
    if (!userInfo.isLoggedIn) return alert("❌ 请先在左侧切换为【已登录模式】！");
    if (!currentBoard || currentBoard.id === "local_guest") return alert("临时白板无法归档");

    setIsSaving(true);
    const latestElements = excalidrawAPIRef.current ? excalidrawAPIRef.current.getSceneElements() : currentBoard.content;

    const { error } = await supabase
      .from("whiteboards")
      .update({ 
        content: latestElements, 
        updated_at: new Date().toISOString() 
      })
      .eq("id", currentBoard.id);

    setIsSaving(false);

    if (error) {
      alert("💾 保存归档失败：" + error.message);
    } else {
      alert("☁️ 存档锁定成功！当前画作已作为云端最新版本备份。");
      fetchBoards(userInfo, false);
    }
  };

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
    setCurrentBoard(newBoard);
  };

  const handlePublish = async (e, board) => {
    e.stopPropagation();
    if (!userInfo.isLoggedIn) return alert("只有登录用户能公开白板");
    if (window.confirm(`确定要公开【${board.title}】并开启联机大厅吗？`)) {
      await supabase.from("whiteboards").update({ is_public: true }).eq("id", board.id);
      const updated = { ...board, is_public: true };
      fetchBoards(userInfo, false);
      setCurrentBoard(updated);
    }
  };

  const toggleTestLogin = () => {
    const nextState = !userInfo.isLoggedIn;
    const mockUser = {
      name: nextState ? "核心创作者_" + Math.floor(Math.random()*10) : `访客_${Math.floor(Math.random() * 100)}`,
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
            {privateBoards.length === 0 && <div style={styles.emptyText}>{userInfo.isLoggedIn ? "暂无，点击+创建" : "登录后开启"}</div>}
          </div>
        </div>

        <div style={{...styles.roomSection, marginTop: "20px"}}>
          <div style={styles.sectionTitle}><span>🌐 公共联机协同大厅</span></div>
          <div style={styles.roomList}>
            {publicBoards.map((board) => (
              <div key={board.id} onClick={() => setCurrentBoard(board)}
                style={{...styles.roomItem, ...(currentBoard?.id === board.id ? styles.activeRoom : {})}}>
                <span style={styles.textEllipsis}>{board.title}</span>
                <span style={styles.ownerTag}>by {board.owner}</span>
              </div>
            ))}
            {publicBoards.length === 0 && <div style={styles.emptyText}>暂无公共画布</div>}
          </div>
        </div>

        <button onClick={toggleTestLogin} style={styles.testLoginBtn}>
          ⚙️ 模拟切换: {userInfo.isLoggedIn ? "访客" : "已登录账号"}
        </button>
      </div>

      {/* 主画布区 */}
      <div style={styles.main}>
        <div style={styles.header}>
          <div style={{display: "flex", alignItems: "center", gap: "12px"}}>
            <h2 style={styles.roomTitle}>{currentBoard?.title || "未选择白板"}</h2>
            {currentBoard && (
              <span style={currentBoard.is_public ? styles.badgePublic : styles.badgePrivate}>
                {currentBoard.is_public ? "P2P 毫秒级联机房" : "独立隔离沙盒"}
              </span>
            )}
          </div>
          
          <div style={{display: "flex", alignItems: "center", gap: "16px"}}>
            {currentBoard && currentBoard.id !== "local_guest" && (
              <button onClick={handleManualSave} disabled={isSaving}
                style={{...styles.manualSaveBtn, backgroundColor: isSaving ? "#9AA0A6" : "#1a73e8"}}>
                {isSaving ? "云端锁定中..." : "☁️ 手动同步存档到云端"}
              </button>
            )}

            {currentBoard?.is_public && (
              <div style={styles.onlineContainer}>
                <span style={styles.onlineText}>协同中:</span>
                {onlineUsers.map((u, idx) => (
                  <div key={idx} style={styles.onlineAvatar} title={u.name}>{u.name.charAt(0)}</div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={{ flex: 1, position: "relative", padding: "0 24px 24px 24px" }}>
          <div className="excalidraw-wrapper" style={{ width: "100%", height: "100%" }}>
            {/* 🌟 绑定标准的组件引用，严控重绘周期 */}
            <Excalidraw 
              excalidrawRef={(api) => {
                if (api && !excalidrawAPIRef.current) {
                  excalidrawAPIRef.current = api;
                  setApiReady(true); // 激活就绪开关
                }
              }} 
              onChange={handleOnChange}
              theme="light" 
            />
          </div>
        </div>
      </div>
    </div>
  );
}

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