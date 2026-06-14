// App.jsx
import React, { useState, useEffect, useRef, useCallback } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://mamubvgmcetepllznifl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HEeNPSqD75cWlnmZjcVHKA_Pw-OdL_A";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CURSOR_SPEED = 2000; // 远程光标移动速度 (像素/秒)

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
  const moveEndTimer = useRef(null);
  const channelRef = useRef(null);

  const lastAppliedTimestampRef = useRef(0);
  const isRemoteUpdatingRef = useRef(false);
  const lastPointerSendTimeRef = useRef(0);

  const collaboratorsRef = useRef(new Map());
  const isChannelReadyRef = useRef(false);

  const isSavingRef = useRef(false);
  const pendingSaveElementsRef = useRef(null);

  const hasUnsavedChangesRef = useRef(false);
  const latestElementsRef = useRef(null);

  // 缓存被忽略的远程更新（当本地有未保存更改时）
  const pendingRemoteUpdateRef = useRef(null);

  const animationFrameIdRef = useRef(null);

  useEffect(() => { injectCSS(); }, []);

  useEffect(() => {
    const initUser = async () => {
      const randomId = Math.random().toString(36).substring(2, 10);
      try {
        const res = await fetch("/api/userinfo");
        if (res.ok) {
          const data = await res.json();
          setUserInfo({ id: randomId, name: data.username, isLoggedIn: true });
          
          // 💡 修复：直接把刚拿到的 data.username 传过去
          await fetchBoards(data.username); 
        } else throw new Error();
      } catch {
        const guestName = `访客_${Math.floor(Math.random() * 1000)}`;
        setUserInfo({ id: randomId, name: guestName, isLoggedIn: false });
        
        // 💡 修复：失败时把生成的访客名传过去
        await fetchBoards(guestName); 
      }
    };
    initUser();
  }, []);

  const fetchBoards = async (currentNameOverride) => {
    const activeUsername = currentNameOverride || userInfo.name;
    
    // 💡 修复 1：使用 .or() 语法，只查询公开的、或者主人是自己的白板
    const { data, error } = await supabase
      .from("whiteboards")
      .select("*")
      .or(`is_public.eq.true,owner.eq."${activeUsername}"`) // 👈 核心安全锁
      .order("updated_at", { ascending: false });

    if (error) return console.error("获取白板失败:", error);

    const publicList = data.filter((b) => b.is_public);
    const privateList = data.filter((b) => b.owner === activeUsername && !b.is_public);

    setPublicBoards(publicList);
    setPrivateBoards(privateList);

    // 💡 修复 2：调整默认选中逻辑，优先进入自己的私密白板，没有再进入公共白板
    if (!currentBoard) {
      const defaultBoard = privateList.length > 0 ? privateList[0] : (publicList.length > 0 ? publicList[0] : null);
      setCurrentBoard(defaultBoard);
    }
  };

  useEffect(() => {
    if (!currentBoard?.id || !userInfo.id) return;

    isChannelReadyRef.current = false;
    collaboratorsRef.current.clear();
    if (channelRef.current) supabase.removeChannel(channelRef.current);
    if (animationFrameIdRef.current) {
      cancelAnimationFrame(animationFrameIdRef.current);
      animationFrameIdRef.current = null;
    }
    clearTimeout(saveTimer.current);
    clearTimeout(moveEndTimer.current);

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
          if (remoteContent.senderId === userInfo.id) return;

          const remoteUpdatedAt = new Date(payload.new.updated_at).getTime();
          if (remoteUpdatedAt <= lastAppliedTimestampRef.current) return;

          // 如果本地有未保存的更改，先缓存这次远程更新，等保存完成后再应用
          if (hasUnsavedChangesRef.current) {
            pendingRemoteUpdateRef.current = { elements: remoteContent.elements, updatedAt: remoteUpdatedAt };
            return;
          }

          applyRemoteUpdate(remoteContent.elements, remoteUpdatedAt);
        }
      )
      .on("broadcast", { event: "pointer_update" }, ({ payload }) => {
        if (payload.userId === userInfo.id || !excalidrawAPIRef.current) return;

        const existing = collaboratorsRef.current.get(payload.userId) || {};
        const now = performance.now();

        const targetPointer = {
          x: payload.pointer.x,
          y: payload.pointer.y,
        };

        if (!existing.displayPointer) {
          existing.displayPointer = { ...targetPointer };
        }
        existing.targetPointer = targetPointer;
        existing.button = payload.button || "up";
        existing.username = payload.name;
        existing.selectedElementIds = payload.selectedElementIds || {};
        existing.lastFrameTime = existing.lastFrameTime || now;

        collaboratorsRef.current.set(payload.userId, existing);
        scheduleCollaboratorsUpdate();
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
          scheduleCollaboratorsUpdate();
        }
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          isChannelReadyRef.current = true;
          await channel.track({ name: userInfo.name });
        }
      });

    return () => {
      // ✅ 先尝试保存当前白板未保存的更改
      if (
        hasUnsavedChangesRef.current &&
        currentBoard &&
        latestElementsRef.current
      ) {
        // 不等待结果，直接发起保存（这里 currentBoard 还是旧的白板）
        executeDBSave(latestElementsRef.current);
      }

      isChannelReadyRef.current = false;
      supabase.removeChannel(channel);
      clearTimeout(saveTimer.current);
      clearTimeout(moveEndTimer.current);
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
        animationFrameIdRef.current = null;
      }
    };
  }, [currentBoard?.id, userInfo.id]);

  // 应用远程更新（被复用的逻辑）
  const applyRemoteUpdate = (elements, updatedAt) => {
    if (!excalidrawAPIRef.current) return;
    lastAppliedTimestampRef.current = updatedAt;
    isRemoteUpdatingRef.current = true;
    excalidrawAPIRef.current.updateScene({
      elements,
      commitToHistory: false,
    });
    latestElementsRef.current = structuredClone(elements);
    setTimeout(() => {
      isRemoteUpdatingRef.current = false;
    }, 60);
  };

  const scheduleCollaboratorsUpdate = useCallback(() => {
    if (animationFrameIdRef.current) return;
    animationFrameIdRef.current = requestAnimationFrame(() => {
      animationFrameIdRef.current = null;
      const hasActiveTweens = interpolateCollaborators();
      if (hasActiveTweens) {
        scheduleCollaboratorsUpdate();
      }
    });
  }, []);

  const interpolateCollaborators = () => {
    if (!excalidrawAPIRef.current) return false;

    const now = performance.now();
    let anyMoving = false;
    const renderMap = new Map();

    for (const [userId, data] of collaboratorsRef.current.entries()) {
      const { displayPointer, targetPointer, button, username, selectedElementIds, lastFrameTime } = data;
      if (!displayPointer || !targetPointer) {
        if (data.pointer) {
          renderMap.set(userId, {
            pointer: data.pointer,
            button: button || "up",
            username,
            selectedElementIds: selectedElementIds || {},
          });
        }
        continue;
      }

      const dt = lastFrameTime ? (now - lastFrameTime) / 1000 : 0.016;
      const dx = targetPointer.x - displayPointer.x;
      const dy = targetPointer.y - displayPointer.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < 0.5) {
        data.displayPointer = { ...targetPointer };
      } else {
        const step = CURSOR_SPEED * dt;
        if (step >= distance) {
          data.displayPointer = { ...targetPointer };
        } else {
          data.displayPointer = {
            x: displayPointer.x + (dx / distance) * step,
            y: displayPointer.y + (dy / distance) * step,
          };
          anyMoving = true;
        }
      }

      data.lastFrameTime = now;

      renderMap.set(userId, {
        pointer: data.displayPointer,
        button: button || "up",
        username,
        selectedElementIds: selectedElementIds || {},
      });
    }

    excalidrawAPIRef.current.updateScene({
      collaborators: renderMap,
    });

    return anyMoving;
  };

  const loadBoardToCanvas = (board) => {
    if (!excalidrawAPIRef.current || !board) return;
    const parsed = parseContent(board.content);
    const elements = parsed.elements;

    lastAppliedTimestampRef.current = new Date(board.updated_at).getTime();

    clearTimeout(saveTimer.current);
    clearTimeout(moveEndTimer.current);
    hasUnsavedChangesRef.current = false;
    pendingRemoteUpdateRef.current = null;
    latestElementsRef.current = structuredClone(elements);

    isRemoteUpdatingRef.current = true;
    excalidrawAPIRef.current.updateScene({ elements });
    setTimeout(() => {
      isRemoteUpdatingRef.current = false;
    }, 60);
  };

  const executeDBSave = async (elements) => {
    if (!currentBoard || isRemoteUpdatingRef.current || !excalidrawAPIRef.current) return;

    // ✅ 权限检查：私有白板只有所有者才能保存
    if (!currentBoard.is_public && currentBoard.owner !== userInfo.name) {
      console.warn("⛔ 你没有权限修改此私有白板");
      hasUnsavedChangesRef.current = false;      // 避免反复尝试保存
      pendingRemoteUpdateRef.current = null;     // 丢弃暂存的远程更新
      return;
    }
    
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
        lastAppliedTimestampRef.current = Math.max(
          lastAppliedTimestampRef.current,
          new Date(data.updated_at).getTime()
        );
      }
      hasUnsavedChangesRef.current = false;

      // 保存成功，检查是否有被暂存的远程更新需要应用
      if (pendingRemoteUpdateRef.current) {
        const pending = pendingRemoteUpdateRef.current;
        pendingRemoteUpdateRef.current = null;
        // 再次确认时间戳，防止应用旧数据
        if (pending.updatedAt > lastAppliedTimestampRef.current) {
          applyRemoteUpdate(pending.elements, pending.updatedAt);
        }
      }
    } catch (e) {
      console.error("保存失败", e);
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);

      if (pendingSaveElementsRef.current) {
        const pending = pendingSaveElementsRef.current;
        pendingSaveElementsRef.current = null;
        executeDBSave(pending);
      }
    }
  };

  const handleOnChange = (elements) => {
    if (!currentBoard || isRemoteUpdatingRef.current) return;

    // 这里的对比现在有效了，因为 latestElementsRef 存的是真正的历史快照
    if (latestElementsRef.current && JSON.stringify(elements) === JSON.stringify(latestElementsRef.current)) {
      return;
    }

    // 💡 修复：使用 structuredClone 进行深拷贝，断开内存引用
    latestElementsRef.current = structuredClone(elements); 
    hasUnsavedChangesRef.current = true;

    // 现在这里的 clearTimeout 能够在持续拖拽时正常工作了！
    clearTimeout(moveEndTimer.current);
    moveEndTimer.current = setTimeout(() => {
      if (hasUnsavedChangesRef.current && !isSavingRef.current) {
        clearTimeout(saveTimer.current);
        executeDBSave(elements);
      }
    }, 300);

    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (isSavingRef.current) {
        pendingSaveElementsRef.current = elements;
      } else {
        executeDBSave(elements);
      }
    }, 800);
  };

  const handlePointerUpdate = (payload) => {
    if (!channelRef.current || !isChannelReadyRef.current) return;

    const now = Date.now();
    if (now - lastPointerSendTimeRef.current < 20) return;

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