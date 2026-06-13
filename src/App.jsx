// App.jsx
import React, { useState, useEffect, useRef } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://mamubvgmcetepllznifl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HEeNPSqD75cWlnmZjcVHKA_Pw-OdL_A";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const injectCSS = () => {
  if (document.getElementById("excalidraw-custom-styles")) return;
  const style = document.createElement("style");
  style.id = "excalidraw-custom-styles";
  style.innerHTML = `
    .sidebar-transition { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
    .hide-scrollbar::-webkit-scrollbar { display: none; }
  `;
  document.head.appendChild(style);
};

const parseContent = (content) => {
  if (!content) return { elements: [], senderId: "" };
  if (Array.isArray(content)) return { elements: content, senderId: "" };
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return { elements: parsed, senderId: "" };
      return { elements: parsed.elements || [], senderId: parsed.senderId || "" };
    } catch { return { elements: [], senderId: "" }; }
  }
  return { elements: content.elements || [], senderId: content.senderId || "" };
};

export default function App() {
  const [userInfo, setUserInfo] = useState({ id: "", name: "访客", isLoggedIn: false });
  const [publicBoards, setPublicBoards] = useState([]);
  const [privateBoards, setPrivateBoards] = useState([]);
  const [currentBoard, setCurrentBoard] = useState(null);
  const [onlineUsers, setOnlineUsers] = useState(new Map());
  const [isSaving, setIsSaving] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const excalidrawAPIRef = useRef(null);
  const saveTimer = useRef(null);
  const channelRef = useRef(null);

  // 使用时间戳代替版本号，消除客户端版本冲突
  const lastAppliedTimestampRef = useRef(0);
  const isRemoteUpdatingRef = useRef(false);
  const lastSaveTimeRef = useRef(0);
  const lastPointerSendTimeRef = useRef(0);

  const collaboratorsRef = useRef(new Map());
  const isChannelReadyRef = useRef(false);

  // 保存正在进行的写入操作，避免并发保存
  const isSavingRef = useRef(false);
  const pendingSaveElementsRef = useRef(null);

  useEffect(() => { injectCSS(); }, []);

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
    const { data, error } = await supabase.from("whiteboards").select("*").order("updated_at", { ascending: false });
    if (error) return console.error("获取白板失败:", error);
    setPublicBoards(data.filter(b => b.is_public));
    setPrivateBoards(data.filter(b => b.owner === userInfo.name && !b.is_public));
    if (!currentBoard && data.length > 0) setCurrentBoard(data[0]);
  };

  useEffect(() => {
    if (!currentBoard?.id || !userInfo.id) return;

    isChannelReadyRef.current = false;
    collaboratorsRef.current.clear();
    if (channelRef.current) supabase.removeChannel(channelRef.current);

    const channel = supabase.channel(`board_${currentBoard.id}`);
    channelRef.current = channel;

    channel
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "whiteboards",
          filter: `id=eq.${currentBoard.id}`,
        },
        (payload) => {
          const remoteContent = parseContent(payload.new.content);
          // 忽略自己的更新
          if (remoteContent.senderId === userInfo.id) return;

          const remoteUpdatedAt = new Date(payload.new.updated_at).getTime();
          // 只接受比本地更新的版本
          if (remoteUpdatedAt <= lastAppliedTimestampRef.current) return;

          // 应用远程元素
          lastAppliedTimestampRef.current = remoteUpdatedAt;
          isRemoteUpdatingRef.current = true;
          excalidrawAPIRef.current?.updateScene({
            elements: remoteContent.elements,
            commitToHistory: false,
          });

          // 短暂锁定后释放，防止本地 onChange 触发保存
          setTimeout(() => {
            isRemoteUpdatingRef.current = false;
          }, 60);
        }
      )
      .on("broadcast", { event: "pointer_update" }, ({ payload }) => {
        if (payload.userId === userInfo.id || !excalidrawAPIRef.current) return;

        collaboratorsRef.current.set(payload.userId, {
          pointer: payload.pointer,
          button: payload.button || "up",
          username: payload.name,
          selectedElementIds: payload.selectedElementIds || {},
        });

        excalidrawAPIRef.current.updateScene({ collaborators: collaboratorsRef.current });
      })
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        setOnlineUsers(new Map(Object.entries(state)));

        const activeUserIds = new Set(Object.keys(state));
        let hasChanged = false;
        for (const userId of collaboratorsRef.current.keys()) {
          if (!activeUserIds.has(userId)) {
            collaboratorsRef.current.delete(userId);
            hasChanged = true;
          }
        }
        if (hasChanged && excalidrawAPIRef.current) {
          excalidrawAPIRef.current.updateScene({ collaborators: collaboratorsRef.current });
        }
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          isChannelReadyRef.current = true;
          await channel.track({ name: userInfo.name });
        }
      });

    loadBoardToCanvas(currentBoard);
    return () => {
      isChannelReadyRef.current = false;
      supabase.removeChannel(channel);
    };
  }, [currentBoard?.id, userInfo.id]);

  const loadBoardToCanvas = (board) => {
    if (!excalidrawAPIRef.current || !board) return;
    const parsed = parseContent(board.content);
    lastAppliedTimestampRef.current = new Date(board.updated_at).getTime();
    isRemoteUpdatingRef.current = true;
    excalidrawAPIRef.current.updateScene({ elements: parsed.elements });
    setTimeout(() => {
      isRemoteUpdatingRef.current = false;
    }, 60);
  };

  // 实际执行数据库保存
  const executeDBSave = async (elements) => {
    if (!currentBoard || isRemoteUpdatingRef.current || !excalidrawAPIRef.current) return;

    isSavingRef.current = true;
    setIsSaving(true);

    const wrappedPayload = {
      elements: elements,
      senderId: userInfo.id,
    };

    try {
      const { data, error } = await supabase
        .from("whiteboards")
        .update({ content: wrappedPayload, updated_at: new Date().toISOString() })
        .eq("id", currentBoard.id)
        .select("updated_at")
        .single();

      if (!error && data?.updated_at) {
        // 更新本地最新时间戳，防止重复应用自己的更新
        lastAppliedTimestampRef.current = Math.max(
          lastAppliedTimestampRef.current,
          new Date(data.updated_at).getTime()
        );
      }
    } catch (e) {
      console.error("保存失败", e);
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
      lastSaveTimeRef.current = Date.now();

      // 如果在保存期间又有新的待保存元素，立刻执行一次保存
      if (pendingSaveElementsRef.current) {
        const pending = pendingSaveElementsRef.current;
        pendingSaveElementsRef.current = null;
        executeDBSave(pending);
      }
    }
  };

  // 优化后的 onChange：缩短节流间隔，放开绘制时的实时同步（但降低频率）
  const handleOnChange = (elements, appState) => {
    if (!currentBoard || isRemoteUpdatingRef.current) return;

    // 决定节流间隔：画笔或拖拽时稍长（150ms），普通操作用极短间隔（80ms）
    const isDrawing = appState.activeTool?.type === "freedraw";
    const isDragging = appState.isDragging;
    const throttleInterval = isDrawing || isDragging ? 150 : 80;

    const now = Date.now();

    // 如果上一次保存距今小于间隔，则用防抖推迟保存
    if (now - lastSaveTimeRef.current < throttleInterval) {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        // 如果正在保存，将最新元素暂存，等待保存完成后自动触发
        if (isSavingRef.current) {
          pendingSaveElementsRef.current = elements;
        } else {
          executeDBSave(elements);
        }
      }, throttleInterval);
      return;
    }

    // 满足间隔，立即保存
    clearTimeout(saveTimer.current);
    if (isSavingRef.current) {
      pendingSaveElementsRef.current = elements;
    } else {
      executeDBSave(elements);
    }
  };

  // 指针广播：保持50ms频率限制
  const handlePointerUpdate = (payload) => {
    if (!channelRef.current || !isChannelReadyRef.current) return;

    const now = Date.now();
    if (now - lastPointerSendTimeRef.current < 50) return;

    lastPointerSendTimeRef.current = now;

    channelRef.current.send({
      type: "broadcast",
      event: "pointer_update",
      payload: {
        userId: userInfo.id,
        name: userInfo.name,
        pointer: payload.pointer,
        button: payload.button,
        selectedElementIds: payload.selectedElementIds,
      },
    });
  };

  const handleCreateBoard = async () => {
    if (!userInfo.isLoggedIn) return alert("请先登录");
    const title = prompt("请输入新白板名称");
    if (!title) return;
    const { data } = await supabase
      .from("whiteboards")
      .insert([{ title, owner: userInfo.name, content: [], is_public: false }])
      .select()
      .single();
    setPrivateBoards((prev) => [data, ...prev]);
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

  const layoutStyles = {
    container: {
      display: "flex",
      height: "100vh",
      width: "100vw",
      backgroundColor: "#f8f9fa",
      padding: isSidebarOpen ? "14px" : "0px",
      gap: isSidebarOpen ? "14px" : "0px",
      boxSizing: "border-box",
      overflow: "hidden",
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
      whiteSpace: "nowrap",
    },
    main: {
      flex: 1,
      borderRadius: isSidebarOpen ? "16px" : "0px",
      background: "#ffffff",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      position: "relative",
      boxShadow: isSidebarOpen ? "0 4px 24px rgba(0,0,0,0.06)" : "none",
    },
  };

  return (
    <div className="sidebar-transition" style={layoutStyles.container}>
      <div className="sidebar-transition" style={layoutStyles.sidebar}>
        <div style={styles.userInfoCard}>
          <div style={styles.avatar}>{userInfo.name.charAt(0)}</div>
          <div>
            <div style={styles.userName}>{userInfo.name}</div>
            <div style={{ ...styles.userStatus, color: userInfo.isLoggedIn ? "#34A853" : "#9AA0A6" }}>
              ● {userInfo.isLoggedIn ? "已登录" : "访客模式"}
            </div>
          </div>
        </div>

        <div className="hide-scrollbar" style={styles.scrollArea}>
          <div style={styles.sectionTitle}>
            我的私密白板
            {userInfo.isLoggedIn && <button onClick={handleCreateBoard} style={styles.fabBtn}>+</button>}
          </div>
          {privateBoards.map((board) => (
            <div
              key={board.id}
              onClick={() => setCurrentBoard(board)}
              style={{
                ...styles.roomItem,
                borderColor: currentBoard?.id === board.id ? "#1a73e8" : "#dadce0",
              }}
            >
              <span style={styles.truncate}>{board.title}</span>
              <div style={styles.actions}>
                <button onClick={(e) => handleTogglePublish(board, e)} style={styles.textBtn}>
                  公开
                </button>
                <button
                  onClick={(e) => handleDeleteBoard(board, e)}
                  style={{ ...styles.textBtn, color: "#d93025" }}
                >
                  删
                </button>
              </div>
            </div>
          ))}

          <div style={{ ...styles.sectionTitle, marginTop: "24px" }}>🌐 公共大厅</div>
          {publicBoards.map((board) => (
            <div
              key={board.id}
              onClick={() => setCurrentBoard(board)}
              style={{
                ...styles.roomItem,
                borderColor: currentBoard?.id === board.id ? "#34a853" : "#dadce0",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <span style={styles.truncate}>{board.title}</span>
                <span style={styles.ownerTag}>by {board.owner}</span>
              </div>
              <div style={styles.actions}>
                {board.owner === userInfo.name && (
                  <>
                    <button
                      onClick={(e) => handleTogglePublish(board, e)}
                      style={{ ...styles.textBtn, color: "#f29900" }}
                    >
                      私有
                    </button>
                    <button
                      onClick={(e) => handleDeleteBoard(board, e)}
                      style={{ ...styles.textBtn, color: "#d93025" }}
                    >
                      删
                    </button>
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

      <div className="sidebar-transition" style={layoutStyles.main}>
        <div
          style={{
            position: "absolute",
            top: 16,
            left: 16,
            zIndex: 10,
            display: "flex",
            gap: "12px",
            alignItems: "center",
          }}
        >
          <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} style={styles.toggleSidebarBtn}>
            {isSidebarOpen ? "◀" : "▶"}
          </button>
          <div style={styles.floatingTitleCard}>
            <span style={{ fontWeight: 600 }}>{currentBoard?.title || "未选择白板"}</span>
            {currentBoard && (
              <span style={styles.tag}>{currentBoard.is_public ? "公共" : "私密"}</span>
            )}
            <span style={{ fontSize: "12px", marginLeft: "8px", color: isSaving ? "#f29900" : "#34a853" }}>
              {isSaving ? "云同步中..." : "已保存到云"}
            </span>
          </div>
        </div>

        <div style={{ flex: 1, position: "relative" }}>
          <Excalidraw
            excalidrawAPI={(api) => {
              excalidrawAPIRef.current = api;
            }}
            onChange={handleOnChange}
            onPointerUpdate={handlePointerUpdate}
            theme="light"
            UIOptions={{ canvasActions: { toggleTheme: false } }}
          />
        </div>
      </div>
    </div>
  );
}

const styles = {
  userInfoCard: {
    display: "flex",
    gap: "12px",
    alignItems: "center",
    marginBottom: "20px",
    paddingBottom: "16px",
    borderBottom: "1px solid #e8eaed",
  },
  avatar: {
    width: "40px",
    height: "40px",
    borderRadius: "50%",
    backgroundColor: "#1a73e8",
    color: "#fff",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    fontSize: "16px",
    fontWeight: "bold",
  },
  userName: { fontWeight: "600", color: "#202124", fontSize: "14px" },
  userStatus: { fontSize: "11px", marginTop: "4px", fontWeight: 600 },
  scrollArea: { flex: 1, overflowY: "auto" },
  sectionTitle: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontWeight: "700",
    color: "#5f6368",
    fontSize: "12px",
    marginBottom: "12px",
    letterSpacing: "0.3px",
  },
  roomItem: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 12px",
    borderRadius: "8px",
    cursor: "pointer",
    background: "#fff",
    marginBottom: "8px",
    border: "1px solid transparent",
    transition: "all 0.2s",
  },
  truncate: {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontSize: "13px",
    color: "#3c4043",
    fontWeight: "500",
    maxWidth: "100px",
  },
  ownerTag: { fontSize: "11px", color: "#80868b", marginTop: "2px" },
  actions: { display: "flex", gap: "2px" },
  fabBtn: {
    borderRadius: "50%",
    width: "24px",
    height: "24px",
    border: "none",
    background: "#1a73e8",
    color: "#fff",
    cursor: "pointer",
    fontSize: "16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 2px 4px rgba(26,115,232,0.2)",
  },
  textBtn: {
    fontSize: "11px",
    padding: "4px 6px",
    borderRadius: "4px",
    border: "none",
    background: "transparent",
    color: "#1a73e8",
    cursor: "pointer",
    fontWeight: "600",
  },
  onlineBadge: {
    marginTop: "16px",
    padding: "10px",
    background: "#e6f4ea",
    borderRadius: "8px",
    fontSize: "12px",
    color: "#137333",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontWeight: "600",
  },
  pulseDot: { width: "8px", height: "8px", backgroundColor: "#34A853", borderRadius: "50%" },
  toggleSidebarBtn: {
    width: "40px",
    height: "40px",
    borderRadius: "8px",
    border: "none",
    background: "#ffffff",
    color: "#5f6368",
    cursor: "pointer",
    boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    fontSize: "12px",
  },
  floatingTitleCard: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "0 16px",
    height: "40px",
    background: "#ffffff",
    borderRadius: "8px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
    fontSize: "13px",
    color: "#202124",
  },
  tag: {
    fontSize: "10px",
    padding: "2px 6px",
    background: "#e8f0fe",
    color: "#1a73e8",
    borderRadius: "4px",
    fontWeight: "600",
  },
};