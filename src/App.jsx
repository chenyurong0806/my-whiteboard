// App.jsx
import React, { useState, useEffect, useRef } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { createClient } from "@supabase/supabase-js";

// ---------------- Supabase 配置 ----------------
const SUPABASE_URL = "https://mamubvgmcetepllznifl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HEeNPSqD75cWlnmZjcVHKA_Pw-OdL_A";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------- App ----------------
export default function App() {
  // ---------------- 状态 ----------------
  const [userInfo, setUserInfo] = useState({ name: "访客", isLoggedIn: false });
  const [publicBoards, setPublicBoards] = useState([]);
  const [privateBoards, setPrivateBoards] = useState([]);
  const [currentBoard, setCurrentBoard] = useState(null);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [isSaving, setIsSaving] = useState(false);

  const excalidrawAPIRef = useRef(null);
  const saveTimer = useRef(null);
  const lastSavedRef = useRef("");

  // ---------------- 初始化用户 ----------------
  useEffect(() => {
    const initUser = async () => {
      try {
        const res = await fetch("/api/userinfo");
        if (res.ok) {
          const data = await res.json();
          setUserInfo({ name: data.username, isLoggedIn: true });
        } else {
          setUserInfo({ name: `访客_${Math.floor(Math.random() * 100)}`, isLoggedIn: false });
        }
      } catch {
        setUserInfo({ name: `访客_${Math.floor(Math.random() * 100)}`, isLoggedIn: false });
      }
      await fetchBoards();
    };
    initUser();
  }, []);

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

    if (privateList.length > 0) setCurrentBoard(privateList[0]);
    else if (publicList.length > 0) setCurrentBoard(publicList[0]);
    else setCurrentBoard({
      id: "guest_board",
      title: "临时白板",
      owner: userInfo.name,
      is_public: false,
      content: []
    });
  };

  // ---------------- 加载白板到画布 ----------------
  const loadBoardToCanvas = (board) => {
    const api = excalidrawAPIRef.current;
    if (!api || !board) return;

    let elements = [];
    try {
      elements = typeof board.content === "string" && board.content.trim() !== ""
        ? JSON.parse(board.content)
        : board.content || [];
    } catch (err) {
      console.error("解析白板失败:", err);
      elements = [];
    }

    api.updateScene({ elements });
    lastSavedRef.current = JSON.stringify(elements);
  };

  useEffect(() => {
    if (currentBoard && excalidrawAPIRef.current) {
      loadBoardToCanvas(currentBoard);
    }
  }, [currentBoard, excalidrawAPIRef.current]);

  // ---------------- 自动保存 ----------------
  const handleOnChange = (elements) => {
    if (!currentBoard) return;
    const json = JSON.stringify(elements);
    if (json === lastSavedRef.current) return;

    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      if (currentBoard.id === "guest_board") return;
      setIsSaving(true);
      const { error } = await supabase
        .from("whiteboards")
        .update({ content: elements, updated_at: new Date().toISOString() })
        .eq("id", currentBoard.id);
      setIsSaving(false);

      if (error) console.error("自动保存失败:", error);
      else lastSavedRef.current = json;
    }, 800);
  };

  // ---------------- 实时同步 ----------------
  useEffect(() => {
    if (!currentBoard?.id) return;

    const channel = supabase
      .channel(`board-${currentBoard.id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "whiteboards",
          filter: `id=eq.${currentBoard.id}`
        },
        (payload) => {
          const board = payload.new;
          const incoming = JSON.stringify(board.content);
          if (incoming === lastSavedRef.current) return;
          setCurrentBoard(prev => ({ ...prev, content: board.content }));
          loadBoardToCanvas(board);
        }
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [currentBoard?.id]);

  // ---------------- 创建新白板 ----------------
  const handleCreateBoard = async () => {
    if (!userInfo.isLoggedIn) return alert("请先登录");
    const title = prompt("请输入新白板名称");
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

  // ---------------- 公开白板 ----------------
  const handlePublish = async (board) => {
    if (!userInfo.isLoggedIn) return alert("请先登录");
    const { data, error } = await supabase
      .from("whiteboards")
      .update({ is_public: true })
      .eq("id", board.id)
      .select()
      .single();

    if (error) return console.error(error);

    await fetchBoards();
    setCurrentBoard(data);
  };

  // ---------------- UI ----------------
  return (
    <div style={styles.container}>
      {/* 侧边栏 */}
      <div style={styles.sidebar}>
        <div style={styles.userInfoCard}>
          <div style={styles.avatar}>{userInfo.name.charAt(0)}</div>
          <div>
            <div style={styles.userName}>{userInfo.name}</div>
            <div style={styles.userStatus}>
              <span style={{ ...styles.statusDot, backgroundColor: userInfo.isLoggedIn ? "#34A853" : "#9AA0A6" }}></span>
              {userInfo.isLoggedIn ? "已登录" : "访客模式"}
            </div>
          </div>
        </div>

        {/* 私有白板 */}
        <div style={styles.roomSection}>
          <div style={styles.sectionTitle}>
            <span>🔒 我的私人白板</span>
            {userInfo.isLoggedIn && <button onClick={handleCreateBoard} style={styles.iconBtn}>+</button>}
          </div>
          <div style={styles.roomList}>
            {privateBoards.map(board => (
              <div key={board.id} onClick={() => setCurrentBoard(board)} style={styles.roomItem}>
                <span>{board.title}</span>
                <button onClick={() => handlePublish(board)} style={styles.publishBtn}>公开</button>
              </div>
            ))}
          </div>
        </div>

        {/* 公共白板 */}
        <div style={{ ...styles.roomSection, marginTop: "20px" }}>
          <div style={styles.sectionTitle}>🌐 公共白板</div>
          <div style={styles.roomList}>
            {publicBoards.map(board => (
              <div key={board.id} onClick={() => setCurrentBoard(board)} style={styles.roomItem}>
                <span>{board.title}</span>
                <span style={styles.ownerTag}>by {board.owner}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 在线人数 */}
        <div style={styles.onlineUsers}>
          <span>在线人数: {onlineUsers.length}</span>
        </div>
      </div>

      {/* 主画布 */}
      <div style={styles.main}>
        <div style={{ flex: 1, position: "relative", padding: "16px" }}>
          <Excalidraw
            excalidrawAPI={(api) => { excalidrawAPIRef.current = api; }}
            onChange={handleOnChange}
            theme="light"
          />
          {isSaving && <div style={{position:"absolute", top:10,right:10, color:"#1a73e8"}}>正在保存...</div>}
        </div>
      </div>
    </div>
  );
}

// ---------------- 样式 ----------------
const styles = {
  container: { display: "flex", height: "100vh", gap: "16px", padding: "16px" },
  sidebar: { width: "280px", background: "#f8f9fa", borderRadius: "16px", display: "flex", flexDirection: "column", padding: "16px" },
  userInfoCard: { display: "flex", gap: "12px", alignItems: "center", marginBottom: "16px" },
  avatar: { width: "40px", height: "40px", borderRadius: "20px", backgroundColor: "#1976d2", color: "#fff", display: "flex", justifyContent: "center", alignItems: "center" },
  userName: { fontWeight: "600" },
  userStatus: { fontSize: "12px", color: "#666", display: "flex", gap: "4px", alignItems: "center" },
  statusDot: { width: "8px", height: "8px", borderRadius: "50%" },
  roomSection: { flex: 1, overflowY: "auto" },
  sectionTitle: { display: "flex", justifyContent: "space-between", fontWeight: "600", marginBottom: "8px" },
  roomList: { display: "flex", flexDirection: "column", gap: "4px" },
  roomItem: { display: "flex", justifyContent: "space-between", padding: "8px", borderRadius: "12px", cursor: "pointer", background: "#fff" },
  iconBtn: { borderRadius: "50%", width: "24px", height: "24px", border: "none", background: "#1976d2", color: "#fff", cursor: "pointer" },
  publishBtn: { fontSize: "11px", padding: "2px 6px", borderRadius: "8px", border: "1px solid #1976d2", background: "transparent", color: "#1976d2", cursor: "pointer" },
  ownerTag: { fontSize: "11px", color: "#80868B" },
  onlineUsers: { marginTop: "16px", fontSize: "12px" },
  main: { flex: 1, borderRadius: "16px", background: "#ffffff", display: "flex", flexDirection: "column" }
};