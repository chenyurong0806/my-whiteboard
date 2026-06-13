import React, { useState, useEffect, useRef } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { createClient } from "@supabase/supabase-js";

// ---------------- Supabase ----------------
const supabase = createClient(
  "https://mamubvgmcetepllznifl.supabase.co",
  "sb_publishable_HEeNPSqD75cWlnmZjcVHKA_Pw-OdL_A"
);

// ---------------- utils ----------------
const stringToColor = (str) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++)
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360},70%,60%)`;
};

// ---------------- App ----------------
export default function App() {
  const [userInfo, setUserInfo] = useState({
    id: "",
    name: "访客",
    isLoggedIn: false,
    color: ""
  });

  const [publicBoards, setPublicBoards] = useState([]);
  const [privateBoards, setPrivateBoards] = useState([]);
  const [currentBoard, setCurrentBoard] = useState(null);
  const [onlineUsers, setOnlineUsers] = useState(new Map());
  const [isSaving, setIsSaving] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const excalidrawAPIRef = useRef(null);
  const channelRef = useRef(null);
  const saveTimer = useRef(null);
  const lastRef = useRef("");

  // ---------------- init user ----------------
  useEffect(() => {
    const id = Math.random().toString(36).slice(2);
    const name = `访客_${Math.floor(Math.random() * 999)}`;

    setUserInfo({
      id,
      name,
      isLoggedIn: false,
      color: stringToColor(name)
    });

    fetchBoards();
  }, []);

  // ---------------- boards ----------------
  const fetchBoards = async () => {
    const { data } = await supabase
      .from("whiteboards")
      .select("*")
      .order("created_at", { ascending: false });

    const pub = data.filter((b) => b.is_public);
    const pri = data.filter((b) => !b.is_public);

    setPublicBoards(pub);
    setPrivateBoards(pri);

    if (!currentBoard && pub.length) setCurrentBoard(pub[0]);
  };

  // ---------------- realtime ----------------
  useEffect(() => {
    if (!currentBoard || !userInfo.id) return;

    if (channelRef.current)
      supabase.removeChannel(channelRef.current);

    const channel = supabase.channel(`board_${currentBoard.id}`, {
      config: {
        presence: { key: userInfo.id }
      }
    });

    channelRef.current = channel;

    // ---------------- presence ----------------
    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState();
      const users = new Map();
      const collaborators = new Map();

      Object.entries(state).forEach(([id, arr]) => {
        const u = arr[0];
        users.set(id, u);

        if (id !== userInfo.id && u.pointer) {
          collaborators.set(id, {
            pointer: u.pointer,
            username: u.name,
            color: u.color
          });
        }
      });

      setOnlineUsers(users);
      excalidrawAPIRef.current?.updateScene({ collaborators });
    });

    // ---------------- realtime draw ----------------
    channel.on("broadcast", { event: "draw" }, ({ payload }) => {
      if (payload.userId === userInfo.id) return;

      const api = excalidrawAPIRef.current;
      if (!api) return;

      api.updateScene({
        elements: payload.elements,
        commitToHistory: false
      });
    });

    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({
          name: userInfo.name,
          color: userInfo.color,
          pointer: null
        });
      }
    });

    loadBoard(currentBoard);

    return () => supabase.removeChannel(channel);
  }, [currentBoard?.id, userInfo.id]);

  // ---------------- load ----------------
  const loadBoard = (board) => {
    const api = excalidrawAPIRef.current;
    if (!api) return;

    let elements = [];
    try {
      elements =
        typeof board.content === "string"
          ? JSON.parse(board.content)
          : board.content || [];
    } catch {}

    api.updateScene({ elements });
    lastRef.current = JSON.stringify(elements);
  };

  // ---------------- change ----------------
  const handleChange = (elements) => {
    if (!currentBoard) return;

    const api = excalidrawAPIRef.current;
    const json = JSON.stringify(elements);

    // ❗1. 实时广播（修复：不再节流错误判断）
    if (channelRef.current) {
      channelRef.current.send({
        type: "broadcast",
        event: "draw",
        payload: {
          userId: userInfo.id,
          elements
        }
      });
    }

    // ❗2. 防抖保存
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setIsSaving(true);

      await supabase
        .from("whiteboards")
        .update({
          content: elements,
          updated_at: new Date().toISOString()
        })
        .eq("id", currentBoard.id);

      setIsSaving(false);
      lastRef.current = json;
    }, 800);
  };

  // ---------------- UI ----------------
  return (
    <div style={styles.container}>
      {/* sidebar */}
      <div
        style={{
          ...styles.sidebar,
          width: sidebarOpen ? 280 : 0,
          padding: sidebarOpen ? 16 : 0,
          opacity: sidebarOpen ? 1 : 0
        }}
      >
        <button
          style={styles.collapseBtn}
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          {sidebarOpen ? "◀" : "▶"}
        </button>

        {sidebarOpen && (
          <>
            <h3>在线：{onlineUsers.size}</h3>

            <div>
              {privateBoards.map((b) => (
                <div
                  key={b.id}
                  style={styles.board}
                  onClick={() => setCurrentBoard(b)}
                >
                  {b.title}
                </div>
              ))}
            </div>

            <div>
              {publicBoards.map((b) => (
                <div
                  key={b.id}
                  style={styles.board}
                  onClick={() => setCurrentBoard(b)}
                >
                  🌍 {b.title}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* canvas */}
      <div
        style={{
          flex: 1,
          marginLeft: sidebarOpen ? 12 : 0
        }}
      >
        <Excalidraw
          excalidrawAPI={(api) => (excalidrawAPIRef.current = api)}
          onChange={handleChange}
        />
      </div>
    </div>
  );
}

// ---------------- styles ----------------
const styles = {
  container: {
    display: "flex",
    height: "100vh"
  },
  sidebar: {
    transition: "all 0.3s",
    background: "#fff",
    overflow: "hidden",
    borderRight: "1px solid #eee"
  },
  collapseBtn: {
    marginBottom: 10
  },
  board: {
    padding: 8,
    margin: 4,
    cursor: "pointer",
    background: "#f5f5f5"
  }
};