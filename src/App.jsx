// App.jsx
import React, { useState, useEffect, useRef, useCallback } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://mamubvgmcetepllznifl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HEeNPSqD75cWlnmZjcVHKA_Pw-OdL_A";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CURSOR_SPEED = 2000;

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

/**
 * 为元素补充时间戳，用于冲突合并
 * prevMap: 旧元素 Map(id => element)，为新元素保留原有的 _lastModified，
 * 若新元素与旧元素内容不同（或新增）则更新为当前时间
 */
const stampElements = (newElements, prevMap = new Map()) => {
  return newElements.map((el) => {
    const old = prevMap.get(el.id);
    let lastModified;
    if (!old) {
      // 新增元素
      lastModified = Date.now();
    } else if (JSON.stringify(old) !== JSON.stringify(el)) {
      // 内容有变化
      lastModified = Date.now();
    } else {
      // 未变化，继承旧时间戳
      lastModified = old._lastModified || Date.now();
    }
    return { ...el, _lastModified: lastModified };
  });
};

/**
 * 合并远程元素与本地元素（用于应用远程更新）
 * 基于 _lastModified 时间戳，保留较新的版本
 */
const mergeElements = (remoteElements, localElements) => {
  const merged = new Map();

  // 先放入本地元素
  for (const el of localElements) {
    merged.set(el.id, { ...el });
  }

  // 再合并远程元素
  for (const rEl of remoteElements) {
    const local = merged.get(rEl.id);
    if (!local) {
      merged.set(rEl.id, { ...rEl });
    } else {
      // 冲突：谁的时间戳更新就用谁
      const rTime = rEl._lastModified || 0;
      const lTime = local._lastModified || 0;
      if (rTime > lTime) {
        merged.set(rEl.id, { ...rEl });
      }
      // 否则保留本地
    }
  }

  return Array.from(merged.values());
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

  const lastAppliedTimestampRef = useRef(0); // 数据库 updated_at 的时间戳
  const isRemoteUpdatingRef = useRef(false);
  const lastPointerSendTimeRef = useRef(0);

  const collaboratorsRef = useRef(new Map());
  const isChannelReadyRef = useRef(false);

  const isSavingRef = useRef(false);
  const pendingSaveElementsRef = useRef(null);

  const hasUnsavedChangesRef = useRef(false);
  const latestElementsRef = useRef(null); // 当前画布最新的元素（含 _lastModified）

  // 缓存被忽略的远程更新（当本地有未保存更改时）
  const pendingRemoteUpdateRef = useRef(null);

  const animationFrameIdRef = useRef(null);

  // 用于标记元素时间戳的旧元素映射（上一次 onChange 时的元素）
  const prevElementsMapRef = useRef(new Map());

  useEffect(() => { injectCSS(); }, []);

  useEffect(() => {
    const initUser = async () => {
      const randomId = Math.random().toString(36).substring(2, 10);
      try {
        const res = await fetch("/api/userinfo");
        if (res.ok) {
          const data = await res.json();
          setUserInfo({ id: randomId, name: data.username, isLoggedIn: true });
          await fetchBoards(data.username);
        } else throw new Error();
      } catch {
        const guestName = `访客_${Math.floor(Math.random() * 1000)}`;
        setUserInfo({ id: randomId, name: guestName, isLoggedIn: false });
        await fetchBoards(guestName);
      }
    };
    initUser();
  }, []);

  const fetchBoards = async (currentNameOverride) => {
    const activeUsername = currentNameOverride || userInfo.name;

    const { data, error } = await supabase
      .from("whiteboards")
      .select("*")
      .or(`is_public.eq.true,owner.eq."${activeUsername}"`)
      .order("updated_at", { ascending: false });

    if (error) return console.error("获取白板失败:", error);

    const publicList = data.filter((b) => b.is_public);
    const privateList = data.filter((b) => b.owner === activeUsername && !b.is_public);

    setPublicBoards(publicList);
    setPrivateBoards(privateList);

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

    loadBoardToCanvas(currentBoard);
    return () => {
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

  // 应用远程更新：与本地元素合并而非直接覆盖
  const applyRemoteUpdate = (remoteElements, updatedAt) => {
    if (!excalidrawAPIRef.current) return;
    const localElements = excalidrawAPIRef.current.getSceneElements() || [];
    // 确保远程元素有时间戳（旧数据可能没有）
    const stampedRemote = remoteElements.map(el => ({ ...el, _lastModified: el._lastModified || updatedAt }));
    const merged = mergeElements(stampedRemote, localElements);
    lastAppliedTimestampRef.current = updatedAt;
    isRemoteUpdatingRef.current = true;
    excalidrawAPIRef.current.updateScene({
      elements: merged,
      commitToHistory: false,
    });
    latestElementsRef.current = structuredClone(merged);
    // 更新 prevElementsMapRef 为合并后的映射，保证后续本地编辑的时间戳正确
    const newMap = new Map();
    merged.forEach(el => newMap.set(el.id, el));
    prevElementsMapRef.current = newMap;
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
    let elements = parsed.elements;

    // 为旧元素补充时间戳
    const boardTime = new Date(board.updated_at).getTime();
    elements = elements.map(el => ({ ...el, _lastModified: el._lastModified || boardTime }));

    lastAppliedTimestampRef.current = boardTime;

    clearTimeout(saveTimer.current);
    clearTimeout(moveEndTimer.current);
    hasUnsavedChangesRef.current = false;
    pendingRemoteUpdateRef.current = null;
    latestElementsRef.current = structuredClone(elements);

    // 更新 prevElementsMapRef
    const newMap = new Map();
    elements.forEach(el => newMap.set(el.id, el));
    prevElementsMapRef.current = newMap;

    isRemoteUpdatingRef.current = true;
    excalidrawAPIRef.current.updateScene({ elements });
    setTimeout(() => {
      isRemoteUpdatingRef.current = false;
    }, 60);
  };

  /**
   * 乐观并发保存：
   * 只有 updated_at 匹配时才写入，否则表示有并发更新，需要拉取最新数据合并后重试
   */
  const executeDBSave = async (elements) => {
    if (!currentBoard || isRemoteUpdatingRef.current || !excalidrawAPIRef.current) return;

    isSavingRef.current = true;
    setIsSaving(true);

    // 深拷贝要保存的元素，避免外部修改
    let elementsToSave = structuredClone(elements);
    const wrappedPayload = {
      elements: elementsToSave,
      senderId: userInfo.id,
    };

    try {
      // 乐观锁：仅当 updated_at 与本地记录的时间戳一致时才允许更新
      const knownTimestamp = new Date(lastAppliedTimestampRef.current).toISOString();
      const { data, error, count } = await supabase
        .from("whiteboards")
        .update({ content: wrappedPayload, updated_at: new Date().toISOString() })
        .eq("id", currentBoard.id)
        .eq("updated_at", knownTimestamp)
        .select("updated_at")
        .single();

      if (error || !data) {
        // 冲突：有人在我们不知情的情况下更新了
        console.warn("保存冲突，尝试合并…");
        // 拉取最新远程数据
        const { data: latest } = await supabase
          .from("whiteboards")
          .select("content, updated_at")
          .eq("id", currentBoard.id)
          .single();

        if (latest) {
          const remoteParsed = parseContent(latest.content);
          const remoteTime = new Date(latest.updated_at).getTime();
          const stampedRemote = remoteParsed.elements.map(el => ({
            ...el,
            _lastModified: el._lastModified || remoteTime,
          }));
          // 合并：以本地的修改优先（本地元素时间戳更新）
          const localElements = elementsToSave;
          const merged = mergeElements(stampedRemote, localElements);

          // 更新本地画布为合并结果
          excalidrawAPIRef.current.updateScene({ elements: merged, commitToHistory: false });
          latestElementsRef.current = structuredClone(merged);
          const newMap = new Map();
          merged.forEach(el => newMap.set(el.id, el));
          prevElementsMapRef.current = newMap;

          // 更新本地时间戳为最新的远程时间，以便下次保存
          lastAppliedTimestampRef.current = remoteTime;

          // 递归重试保存（此时是合并后的数据）
          isSavingRef.current = false;
          setIsSaving(false);
          return executeDBSave(merged);
        }
        // 如果拉取失败，放弃本次保存
        isSavingRef.current = false;
        setIsSaving(false);
        return;
      }

      // 保存成功，更新时间戳
      if (data?.updated_at) {
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
        if (pending.updatedAt > lastAppliedTimestampRef.current) {
          applyRemoteUpdate(pending.elements, pending.updatedAt);
        }
      }
    } catch (e) {
      console.error("保存失败", e);
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);

      // 处理保存期间积压的新变更
      if (pendingSaveElementsRef.current) {
        const pending = pendingSaveElementsRef.current;
        pendingSaveElementsRef.current = null;
        executeDBSave(pending);
      }
    }
  };

  const handleOnChange = (elements) => {
    if (!currentBoard || isRemoteUpdatingRef.current) return;

    // 为元素添加/更新时间戳（通过比较旧映射）
    const prevMap = prevElementsMapRef.current;
    const stampedElements = stampElements(elements, prevMap);

    // 更新 prevElementsMapRef 为当前快照
    const newMap = new Map();
    stampedElements.forEach(el => newMap.set(el.id, el));
    prevElementsMapRef.current = newMap;

    if (latestElementsRef.current && JSON.stringify(stampedElements) === JSON.stringify(latestElementsRef.current)) {
      return;
    }

    latestElementsRef.current = structuredClone(stampedElements);
    hasUnsavedChangesRef.current = true;

    clearTimeout(moveEndTimer.current);
    moveEndTimer.current = setTimeout(() => {
      if (hasUnsavedChangesRef.current && !isSavingRef.current) {
        clearTimeout(saveTimer.current);
        executeDBSave(stampedElements);
      }
    }, 300);

    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (isSavingRef.current) {
        pendingSaveElementsRef.current = stampedElements;
      } else {
        executeDBSave(stampedElements);
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