// App.jsx
import React, { useState, useEffect, useRef, useCallback } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { createClient } from "@supabase/supabase-js";
import "./app.scss";
import "./index.scss";

const SUPABASE_URL = "https://mamubvgmcetepllznifl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HEeNPSqD75cWlnmZjcVHKA_Pw-OdL_A";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CURSOR_SPEED = 2000; // 远程光标移动速度 (像素/秒)

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
      if (
        hasUnsavedChangesRef.current &&
        currentBoard &&
        latestElementsRef.current
      ) {
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

  const executeDBSave = async (elements) => {
    if (!currentBoard || isRemoteUpdatingRef.current || !excalidrawAPIRef.current) return;

    if (!currentBoard.is_public && currentBoard.owner !== userInfo.name) {
      console.warn("⛔ 你没有权限修改此私有白板");
      hasUnsavedChangesRef.current = false;
      pendingRemoteUpdateRef.current = null;
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

      if (pendingSaveElementsRef.current) {
        const pending = pendingSaveElementsRef.current;
        pendingSaveElementsRef.current = null;
        executeDBSave(pending);
      }
    }
  };

  const handleOnChange = (elements) => {
    if (!currentBoard || isRemoteUpdatingRef.current) return;

    if (latestElementsRef.current && JSON.stringify(elements) === JSON.stringify(latestElementsRef.current)) {
      return;
    }

    latestElementsRef.current = structuredClone(elements); 
    hasUnsavedChangesRef.current = true;

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

  return (
    <div 
      className="app-container sidebar-transition" 
      style={{
        padding: isSidebarOpen ? "16px" : "0px",
        gap: isSidebarOpen ? "16px" : "0px",
      }}
    >
      {/* --- 左侧抽屉菜单 (MD3 Navigation Drawer) --- */}
      <div 
        className="md3-sidebar sidebar-transition"
        style={{
          width: isSidebarOpen ? "320px" : "0px",
          opacity: isSidebarOpen ? 1 : 0,
          padding: isSidebarOpen ? "24px 16px" : "0px",
        }}
      >
        {/* 用户信息卡片 */}
        <div className="md3-user-card">
          <div className="md3-avatar md3-interactive">{userInfo.name.charAt(0)}</div>
          <div>
            <div className="md3-user-name">{userInfo.name}</div>
            <div className="md3-user-status" style={{ color: userInfo.isLoggedIn ? "#146C2E" : "#79747E" }}>
              <span style={{ fontSize: "16px", lineHeight: 0 }}>●</span> {userInfo.isLoggedIn ? "已登录" : "访客模式"}
            </div>
          </div>
        </div>

        {/* 可滚动列表区 */}
        <div className="hide-scrollbar" style={{ flex: 1, overflowY: "auto" }}>
          
          <div className="md3-section-title">
            我的私密白板
            {userInfo.isLoggedIn && (
              <button className="md3-fab-small md3-interactive" onClick={handleCreateBoard}>
                +
              </button>
            )}
          </div>

          {privateBoards.map((board) => (
            <div
              key={board.id}
              onClick={() => setCurrentBoard(board)}
              className={`md3-nav-item md3-interactive ${currentBoard?.id === board.id ? 'active' : ''}`}
            >
              <span className="md3-nav-title">{board.title}</span>
              <div style={{ display: "flex", gap: "4px" }}>
                <button 
                  onClick={(e) => handleTogglePublish(board, e)} 
                  className="md3-text-btn primary md3-interactive"
                >
                  公开
                </button>
                <button
                  onClick={(e) => handleDeleteBoard(board, e)}
                  className="md3-text-btn danger md3-interactive"
                >
                  删
                </button>
              </div>
            </div>
          ))}

          <div className="md3-section-title" style={{ marginTop: "32px" }}>🌐 公共大厅</div>
          {publicBoards.map((board) => (
            <div
              key={board.id}
              onClick={() => setCurrentBoard(board)}
              className={`md3-nav-item md3-interactive ${currentBoard?.id === board.id ? 'active' : ''}`}
            >
              <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <span className="md3-nav-title">{board.title}</span>
                <span style={{ fontSize: "11px", opacity: 0.7, marginTop: "2px" }}>by {board.owner}</span>
              </div>
              
              <div style={{ display: "flex", gap: "4px" }}>
                {board.owner === userInfo.name && (
                  <>
                    <button
                      onClick={(e) => handleTogglePublish(board, e)}
                      className="md3-text-btn primary md3-interactive"
                    >
                      私有
                    </button>
                    <button
                      onClick={(e) => handleDeleteBoard(board, e)}
                      className="md3-text-btn danger md3-interactive"
                    >
                      删
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* 在线状态 Badge */}
        <div className="md3-online-badge">
          <div style={{ width: 8, height: 8, backgroundColor: "#21005D", borderRadius: "50%" }}></div> 
          房间内在线: {onlineUsers.size}
        </div>
      </div>

      {/* --- 右侧主工作区 --- */}
      <div 
        className="md3-main-area sidebar-transition"
        style={{
          borderRadius: isSidebarOpen ? "24px" : "0px",
        }}
      >
        {/* 顶部浮动操作栏 */}
        <div className="md3-floating-bar">
          <button 
            onClick={() => setIsSidebarOpen(!isSidebarOpen)} 
            className="md3-icon-btn md3-interactive"
          >
            {isSidebarOpen ? "◀" : "☰"}
          </button>
          
          <div className="md3-top-card">
            <span style={{ fontWeight: 600 }}>{currentBoard?.title || "未选择白板"}</span>
            {currentBoard && (
              <span className="md3-chip">{currentBoard.is_public ? "公共" : "私密"}</span>
            )}
            <span style={{ fontSize: "12px", marginLeft: "12px", color: isSaving ? "var(--md-sys-color-primary)" : "#146C2E", fontWeight: 500 }}>
              {isSaving ? "云同步中..." : "已保存到云"}
            </span>
          </div>
        </div>

        {/* 白板画布容器 */}
        <div style={{ flex: 1, position: "relative", borderRadius: "inherit" }}>
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