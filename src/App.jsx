import { useEffect, useState, useRef } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import { createClient } from "@supabase/supabase-js";
import "@excalidraw/excalidraw/index.css";

// ⚠️ 请换成你自己的真实 URL 和 Key
const SUPABASE_URL = "https://mamubvgmcetepllznifl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HEeNPSqD75cWlnmZjcVHKA_Pw-OdL_A";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function App() {
  const [excalidrawAPI, setExcalidrawAPI] = useState(null);
  const isReceiving = useRef(false);
  const channelRef = useRef(null);      // 💡 用来保存唯一的通信频道
  const lastSentRef = useRef(0);        // 💡 用来限制发送频率

  useEffect(() => {
    if (!excalidrawAPI) return;

    // 1. 初始化频道，并存入 channelRef.current 中
    const channel = supabase.channel("my_secret_room_999", {
      config: { broadcast: { self: false } } // 不发给自己，省流量
    });

    channel
      .on("broadcast", { event: "draw-sync" }, ({ payload }) => {
        // 2. 收到别人的画笔数据
        isReceiving.current = true;
        excalidrawAPI.updateScene({ elements: payload.elements });
        
        // 延时解锁，避免死循环
        setTimeout(() => { isReceiving.current = false; }, 60);
      })
      .subscribe((status) => {
        console.log("Supabase 实时通道状态:", status); // 可以在控制台看看是不是 SUBSCRIBED
      });

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
    };
  }, [excalidrawAPI]);

  // 3. 当你在屏幕上画画时触发
  const handleOnChange = (elements) => {
    // 如果是接收别人数据导致的改变，或者频道还没准备好，就不外发
    if (isReceiving.current || !channelRef.current) return;

    // 💡 节流控制：每 50 毫秒最多发一次，防止高频操作把网络卡死
    const now = Date.now();
    if (now - lastSentRef.current < 50) return;
    lastSentRef.current = now;

    // 4. 使用已经连接好的频道直接发送
    channelRef.current.send({
      type: "broadcast",
      event: "draw-sync",
      payload: { elements },
    });
  };

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <Excalidraw 
        excalidrawRef={(api) => setExcalidrawAPI(api)} 
        onChange={handleOnChange}
      />
    </div>
  );
}

export default App;