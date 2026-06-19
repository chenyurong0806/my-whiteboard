import React, { useState, useEffect, useRef, useCallback } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { createClient } from "@supabase/supabase-js";
import "./index.css";

const SUPABASE_URL = "https://mamubvgmcetepllznifl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HEeNPSqD75cWlnmZjcVHKA_Pw-OdL_A";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CURSOR_SPEED = 2000;

const parseContent = (content) => {
  if (!content) return { elements: [], senderId: "" };
  if (Array.isArray(content)) return { elements: content, senderId: "" };
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return { elements: parsed, senderId: "" };
      return { elements: parsed.elements || [], senderId: parsed.senderId || "" };
    } catch {
      return { elements: [], senderId: "" };
    }
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
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 1024);
  const isResizing = useRef(false);

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
  const pendingRemoteUpdateRef = useRef(null);

  const animationFrameIdRef = useRef(null);
  const broadcastTimer = useRef(null);

  const handleResizeStart = (e) => {
    e.preventDefault();
    isResizing.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const sidebarEl = document.querySelector(".sidebar");
    if (sidebarEl) sidebarEl.style.transition = "none";

    const onMouseMove = (e) => {
      if (!isResizing.current) return;
      const delta = e.clientX - startX;
      const newWidth = Math.min(500, Math.max(200, startWidth + delta));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizing.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      if (sidebarEl) {
        sidebarEl.style.transition = "width 0.3s cubic-bezier(0.4, 0, 0.2, 1), padding 0.3s ease";
      }
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  useEffect(() => {
    const forceSave = () => {
      if (!hasUnsavedChangesRef.current || !currentBoard) return;
      const elements = excalidrawAPIRef.current?.getSceneElements();
      if (!elements) return;
      const wrapped = { elements, senderId: userInfo.id };
      fetch(`${SUPABASE_URL}/rest/v1/whiteboards?id=eq.${currentBoard.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ content: wrapped, updated_at: new Date().toISOString() }),
        keepalive: true,
      });
    };
    window.addEventListener('beforeunload', forceSave);
    return () => {
      window.removeEventListener('beforeunload', forceSave);
      if (hasUnsavedChangesRef.current && currentBoard) {
        const elements = excalidrawAPIRef.current?.getSceneElements();
        if (elements) executeDBSave(elements, true);
      }
    };
  }, [currentBoard, userInfo.id]);

  useEffect(() => {
    const addPressed = (e) => {
      const target = e.target.closest('.icon-btn, .text-btn, .toggle-btn, .board-item');
      if (target) {
        target.classList.add('pressed');
        setTimeout(() => target.classList.remove('pressed'), 200);
      }
    };
    const removePressed = (e) => {
      const target = e.target.closest('.icon-btn, .text-btn, .toggle-btn, .board-item');
      if (target) target.classList.remove('pressed');
    };
    const clearAllPressed = () => document.querySelectorAll('.pressed').forEach(el => el.classList.remove('pressed'));

    document.addEventListener('mousedown', addPressed);
    document.addEventListener('mouseup', removePressed);
    document.addEventListener('mouseleave', clearAllPressed);

    const handleMouseDown = (e) => {
      const btn = e.target.closest('.icon-btn, .text-btn, .toggle-btn');
      if (btn) {
        addRipple(e, btn, 'hold');
        return;
      }
      const boardItem = e.target.closest('.board-item');
      if (boardItem) {
        addRipple(e, boardItem, 'hold');
      }
    };

    const addRipple = (e, el, type) => {
      el.querySelectorAll('.ripple').forEach(r => r.remove());
      const ripple = document.createElement('span');
      ripple.className = 'ripple';
      const rect = el.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      ripple.style.width = ripple.style.height = `${size}px`;
      ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
      ripple.style.top = `${e.clientY - rect.top - size / 2}px`;

      if (type === 'hold') {
        ripple.classList.add('ripple-hold');
        el._ripple = ripple;
        el.appendChild(ripple);

        const onRelease = () => {
          if (!el._ripple) return;
          const cr = el._ripple;
          el._ripple = null;
          const computed = getComputedStyle(cr);
          const matrix = new DOMMatrixReadOnly(computed.transform);
          const scale = matrix.a;
          cr.style.setProperty('--ripple-current-scale', scale);
          cr.classList.remove('ripple-hold');
          cr.classList.add('ripple-release');
          cr.addEventListener('animationend', () => cr.remove(), { once: true });
          el.removeEventListener('mouseup', onRelease);
          el.removeEventListener('mouseleave', onRelease);
        };
        el.addEventListener('mouseup', onRelease, { once: true });
        el.addEventListener('mouseleave', onRelease, { once: true });
      }
    };

    document.addEventListener('mousedown', handleMouseDown);

    return () => {
      document.removeEventListener('mousedown', addPressed);
      document.removeEventListener('mouseup', removePressed);
      document.removeEventListener('mouseleave', clearAllPressed);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, []);

  useEffect(() => {
    const initUser = async () => {
      const randomId = Math.random().toString(36).substring(2, 10);
      const IS_DEV_LOGIN = false;
      if (IS_DEV_LOGIN) {
        const mockUsername = "本地调试员";
        setUserInfo({ id: randomId, name: mockUsername, isLoggedIn: true });
        await fetchBoards(mockUsername);
        return;
      }

      try {
        const res = await fetch("/api/userinfo");
        if (res.ok) {
          const result = await res.json(); // 改名为 result 避免混淆

          // 确保后端成功且拿到了 data 里面的 username
          if (result.loggedIn && result.data && result.data.username) {
            const username = result.data.username;
            setUserInfo({ id: randomId, name: username, isLoggedIn: true });
            await fetchBoards(username);
          } else {
            // 如果 loggedIn 为 false，走访客逻辑
            throw new Error("未登录或数据缺失");
          }
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

    if (currentBoard && excalidrawAPIRef.current) {
      loadBoardToCanvas(currentBoard);
    }

    isChannelReadyRef.current = false;
    collaboratorsRef.current.clear();
    if (channelRef.current) supabase.removeChannel(channelRef.current);
    if (animationFrameIdRef.current) {
      cancelAnimationFrame(animationFrameIdRef.current);
      animationFrameIdRef.current = null;
    }
    clearTimeout(saveTimer.current);
    clearTimeout(moveEndTimer.current);
    clearTimeout(broadcastTimer.current);

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

          lastAppliedTimestampRef.current = remoteUpdatedAt;
        }
      )
      .on("broadcast", { event: "pointer_update" }, ({ payload }) => {
        if (payload.userId === userInfo.id || !excalidrawAPIRef.current) return;

        const existing = collaboratorsRef.current.get(payload.userId) || {};
        const now = performance.now();

        const targetPointer = { x: payload.pointer.x, y: payload.pointer.y };

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
      .on("broadcast", { event: "element_update" }, ({ payload }) => {
        if (payload.senderId === userInfo.id || !excalidrawAPIRef.current) return;
        mergeRemoteElements(payload.elements, Date.now());
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
          await channel.track({ name: userInfo.name, currentBoardId: currentBoard.id });
        }
      });

    return () => {
      const trySaveUnsaved = () => {
        if (!hasUnsavedChangesRef.current || !currentBoard) return;
        const currentElements = excalidrawAPIRef.current?.getSceneElementsIncludingDeleted
          ? excalidrawAPIRef.current.getSceneElementsIncludingDeleted()
          : latestElementsRef.current;
        if (currentElements) {
          executeDBSave(currentElements, true);
        } else {
          executeDBSave(latestElementsRef.current || [], true);
        }
      };
      trySaveUnsaved();

      isChannelReadyRef.current = false;
      supabase.removeChannel(channel);
      clearTimeout(saveTimer.current);
      clearTimeout(moveEndTimer.current);
      clearTimeout(broadcastTimer.current);
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
        animationFrameIdRef.current = null;
      }
    };
  }, [currentBoard?.id, userInfo.id]);

  const loadBoardToCanvas = useCallback((board) => {
    if (!excalidrawAPIRef.current || !board) return;
    const parsed = parseContent(board.content);
    const elements = parsed.elements;
    lastAppliedTimestampRef.current = new Date(board.updated_at).getTime();
    hasUnsavedChangesRef.current = false;
    pendingRemoteUpdateRef.current = null;
    latestElementsRef.current = structuredClone(elements);
    isRemoteUpdatingRef.current = true;
    excalidrawAPIRef.current.updateScene({ elements });
    setTimeout(() => {
      isRemoteUpdatingRef.current = false;
    }, 60);
  }, []);

  const mergeRemoteElements = (remoteElements, updatedAt) => {
    if (!excalidrawAPIRef.current) return;
    const localElements = excalidrawAPIRef.current.getSceneElementsIncludingDeleted
      ? excalidrawAPIRef.current.getSceneElementsIncludingDeleted()
      : latestElementsRef.current || excalidrawAPIRef.current.getSceneElements();

    const mergedMap = new Map();
    localElements.forEach(el => mergedMap.set(el.id, el));

    remoteElements.forEach(el => {
      const existing = mergedMap.get(el.id);
      if (!existing || el.version > existing.version) {
        mergedMap.set(el.id, el);
      }
    });

    const mergedElements = Array.from(mergedMap.values());
    if (elementsAreEqual(localElements, mergedElements)) return;

    lastAppliedTimestampRef.current = updatedAt;
    isRemoteUpdatingRef.current = true;
    excalidrawAPIRef.current.updateScene({
      elements: mergedElements,
      commitToHistory: false,
    });
    latestElementsRef.current = structuredClone(mergedElements);
    setTimeout(() => {
      isRemoteUpdatingRef.current = false;
    }, 60);
  };

  const elementsAreEqual = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id || a[i].version !== b[i].version) return false;
    }
    return true;
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

    excalidrawAPIRef.current.updateScene({ collaborators: renderMap });
    return anyMoving;
  };

  const executeDBSave = async (elements, force = false) => {
    if (!currentBoard) return;
    if (!force && (isRemoteUpdatingRef.current || !excalidrawAPIRef.current)) return;

    if (!currentBoard.is_public && currentBoard.owner !== userInfo.name) {
      console.warn("⛔ 你没有权限修改此私有白板");
      hasUnsavedChangesRef.current = false;
      pendingRemoteUpdateRef.current = null;
      return;
    }

    if (isSavingRef.current) {
      pendingSaveElementsRef.current = elements;
      return;
    }

    const elementsToSave = structuredClone(elements);
    isSavingRef.current = true;
    setIsSaving(true);

    const wrappedPayload = { elements: elementsToSave, senderId: userInfo.id };

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

      if (pendingRemoteUpdateRef.current) {
        const pending = pendingRemoteUpdateRef.current;
        pendingRemoteUpdateRef.current = null;
        if (pending.updatedAt > lastAppliedTimestampRef.current) {
          mergeRemoteElements(pending.elements, pending.updatedAt);
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
        if (pending !== elementsToSave) {
          executeDBSave(pending);
        }
      }
    }
  };

  const handleOnChange = (elements) => {
    if (!currentBoard || isRemoteUpdatingRef.current) return;

    latestElementsRef.current = elements;
    hasUnsavedChangesRef.current = true;

    clearTimeout(broadcastTimer.current);
    broadcastTimer.current = setTimeout(() => {
      if (channelRef.current && isChannelReadyRef.current) {
        channelRef.current.send({
          type: 'broadcast',
          event: 'element_update',
          payload: { elements: elements, senderId: userInfo.id },
        });
      }
      pendingRemoteUpdateRef.current = null;
    }, 50);

    clearTimeout(moveEndTimer.current);
    moveEndTimer.current = setTimeout(() => {
      if (hasUnsavedChangesRef.current) {
        clearTimeout(saveTimer.current);
        executeDBSave(elements);
      }
    }, 800);

    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (hasUnsavedChangesRef.current && !isSavingRef.current) {
        executeDBSave(elements);
      }
    }, 2000);
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

  const switchBoard = async (board) => {
    if (currentBoard && hasUnsavedChangesRef.current) {
      clearTimeout(saveTimer.current);
      clearTimeout(moveEndTimer.current);
      clearTimeout(broadcastTimer.current);
      const elements = excalidrawAPIRef.current?.getSceneElements();
      if (elements) {
        await executeDBSave(elements, true);
      }
    }
    setCurrentBoard(board);
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

    if (currentBoard?.id === board.id) {
      const elements = excalidrawAPIRef.current?.getSceneElements();
      if (elements && hasUnsavedChangesRef.current) {
        await executeDBSave(elements, true);
      }
    }
    await supabase.from("whiteboards").delete().eq("id", board.id);
    if (currentBoard?.id === board.id) setCurrentBoard(null);
    await fetchBoards();
  };

  // 1. 获取当前所有在线用户的去重列表（用于 main-header 渲染头像）
  const uniqueOnlineUsers = React.useMemo(() => {
    const list = [];
    const seenNames = new Set();
    onlineUsers.forEach((presenceArray) => {
      if (Array.isArray(presenceArray)) {
        presenceArray.forEach(p => {
          if (p.name && !seenNames.has(p.name)) {
            seenNames.add(p.name);
            list.push({ name: p.name, boardId: p.currentBoardId });
          }
        });
      } else if (presenceArray && presenceArray.name) {
        if (!seenNames.has(presenceArray.name)) {
          seenNames.add(presenceArray.name);
          list.push({ name: presenceArray.name, boardId: presenceArray.currentBoardId });
        }
      }
    });
    return list;
  }, [onlineUsers]);

  // 2. 辅助函数：判断某个 whiteboard 是否有其他人在看
  const getBoardOnlineCount = useCallback((boardId) => {
    // 过滤出处于该白板，且不等于当前用户自己的人数
    return uniqueOnlineUsers.filter(u => u.boardId === boardId && u.name !== userInfo.name).length;
  }, [uniqueOnlineUsers, userInfo.name]);

  const toggleIcon = isSidebarOpen ? (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 4 L6 8 L10 12" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4 L10 8 L6 12" />
    </svg>
  );

  return (
    <div className="app-container">
      <div
        className={`sidebar ${isSidebarOpen ? "open" : "closed"}`}
        style={{
          width: isSidebarOpen ? sidebarWidth : 0,
          padding: isSidebarOpen ? "var(--space-xl) var(--space-lg)" : 0,
          overflow: "hidden",
          opacity: isSidebarOpen ? 1 : 0,
        }}
      >
        <div className="user-card">
          <div className="avatar">{userInfo.name.charAt(0)}</div>
          <div>
            <div className="user-name">{userInfo.name}</div>
            <div
              className="user-status"
              style={{ color: userInfo.isLoggedIn ? "var(--color-success)" : "var(--color-text-muted)" }}
            >
              ● {userInfo.isLoggedIn ? "已登录" : "访客模式"}
            </div>
          </div>
        </div>

        <div className="scroll-area hide-scrollbar">
          <div className="section-title">
            <span>我的私密白板</span>
            <button
              className={`icon-btn add-board-btn ${!userInfo.isLoggedIn ? "disabled" : ""}`}
              onClick={handleCreateBoard}
              disabled={!userInfo.isLoggedIn}
              title={userInfo.isLoggedIn ? "新建白板" : "请先登录"}
            >
              +
            </button>
          </div>
          {privateBoards.map((board) => {
            const onlineCount = getBoardOnlineCount(board.id);
            return (
              <div
                key={board.id}
                className={`board-item ${currentBoard?.id === board.id ? "active" : ""}`}
                onClick={() => switchBoard(board)}
              >
                <div className="board-meta">
                  <span className="board-title">{board.title}</span>
                  {onlineCount > 0 && (
                    <span className="board-online-tag">● {onlineCount} 人在线</span>
                  )}
                </div>
                <div className="action-buttons">
                  <button className="text-btn btn-primary-lite" onClick={(e) => handleTogglePublish(board, e)}>公开</button>
                  <button className="text-btn btn-danger-lite" onClick={(e) => handleDeleteBoard(board, e)}>删</button>
                </div>
              </div>
            );
          })}

          <div className="section-title">🌐 公共大厅</div>
          {publicBoards.map((board) => {
            const onlineCount = getBoardOnlineCount(board.id);
            return (
              <div
                key={board.id}
                className={`board-item ${currentBoard?.id === board.id ? "public-active" : ""}`}
                onClick={() => switchBoard(board)}
              >
                <div className="board-meta">
                  <span className="board-title">{board.title}</span>
                  <span className="owner-tag">by {board.owner}</span>
                  {onlineCount > 0 && (
                    <span className="board-online-tag">● {onlineCount} 人在线</span>
                  )}
                </div>
                <div className="action-buttons">
                  {board.owner === userInfo.name ? (
                    <>
                      <button className="text-btn btn-warning-lite" onClick={(e) => handleTogglePublish(board, e)}>私有</button>
                      <button className="text-btn btn-danger-lite" onClick={(e) => handleDeleteBoard(board, e)}>删</button>
                    </>
                  ) : (
                    <span className="visitor-badge">只读/协同</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {isSidebarOpen && (
        <div className="resize-handle" onMouseDown={handleResizeStart} />
      )}

      <div className={`main-area ${isSidebarOpen ? "with-sidebar" : "without-sidebar"}`}>
        <div className="main-header">
          <div className="main-header-left">
            <button className="toggle-btn" onClick={() => setIsSidebarOpen(!isSidebarOpen)}>
              {toggleIcon}
            </button>
            <div className="board-info">
              <span className="board-info-title">{currentBoard?.title || "未选择白板"}</span>
              {currentBoard && <span className="tag">{currentBoard.is_public ? "公共" : "私密"}</span>}
              {isSaving && <span className="save-status-tag">正在同步...</span>}
            </div>
          </div>

          {/* 新增：右侧协同头像状态栏 */}
          <div className="main-header-right">
            <div className="avatar-stack">
              {uniqueOnlineUsers.slice(0, 4).map((user, idx) => (
                <div
                  key={idx}
                  className={`stack-avatar ${user.name === userInfo.name ? "is-me" : ""}`}
                  title={`${user.name} ${user.name === userInfo.name ? '(我)' : ''}`}
                >
                  {user.name.charAt(0)}
                </div>
              ))}
              {uniqueOnlineUsers.length > 4 && (
                <div className="stack-avatar avatar-more" title={`还有 ${uniqueOnlineUsers.length - 4} 名用户`}>
                  +{uniqueOnlineUsers.length - 4}
                </div>
              )}
            </div>
            <div className="online-indicator-text">
              <span>{uniqueOnlineUsers.length} 人正在协同</span>
            </div>
          </div>
        </div>

        <div className="excalidraw-wrapper">
          <Excalidraw
            excalidrawAPI={(api) => {
              excalidrawAPIRef.current = api;
              if (currentBoard && api.getSceneElements().length === 0) {
                loadBoardToCanvas(currentBoard);
              }
            }}
            onChange={handleOnChange}
            onPointerUpdate={handlePointerUpdate}
            theme="light"
            UIOptions={{ canvasActions: { toggleTheme: false, export: false, loadScene: false, saveAsImage: false, help: false, library: false } }}
          />
        </div>
      </div>
    </div>
  );
}
