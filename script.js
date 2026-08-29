// 1. ตั้งค่า Supabase (ใช้ URL และ Key ของคุณ)
const SUPABASE_URL = 'https://vyvuhwnhgcmbokkshnxo.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5dnVod25oZ2NtYm9ra3NobnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwMjU1MDIsImV4cCI6MjEwMzYwMTUwMn0.FYzIS30XtiPNaBRxv6VaS6VOG4hRmP1rFljFINwm_do';
const supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ตัวแปรระบบ
let user = null;
let localStream = null;
let peerConnection = null;
let signalingChannel = null;

// เซิร์ฟเวอร์เจาะทะลุเน็ต (ฟรีของ Google)
const rtcConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// ดึงตัวปุ่มต่างๆ จาก HTML
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const skipBtn = document.getElementById('skipBtn');
const stopBtn = document.getElementById('stopBtn');
const remoteAudio = document.getElementById('remoteAudio');

// 2. ฟังก์ชันเริ่มแรก: ล็อกอินอัตโนมัติและหาประเทศ
async function initApp() {
    try {
        // ล็อกอินแบบไม่ระบุตัวตน
        const { data: authData, error: authError } = await supabase.auth.signInAnonymously();
        if (authError) throw authError;
        user = authData.user;

        // ดึงชื่อประเทศจาก IP
        let country = 'Unknown';
        try {
            const ipRes = await fetch('https://ipapi.co/json/');
            const ipData = await ipRes.json();
            country = ipData.country_name || 'Unknown';
        } catch (e) {
            console.log('หาประเทศไม่เจอ ใช้ Unknown');
        }

        // บันทึกข้อมูลลงฐานข้อมูล
        await supabase.from('profiles').upsert({ id: user.id, country: country });
        
        // แสดงข้อมูลบนหน้าเว็บ
        const shortId = user.id.substring(0, 5);
        document.getElementById('userInfo').innerHTML = `👤 ชื่อ: Guest_${shortId}<br>🌍 ประเทศ: ${country}`;
    } catch (err) {
        document.getElementById('userInfo').innerHTML = `❌ เชื่อมต่อระบบล้มเหลว โปรดรีเฟรชหน้าเว็บ`;
        console.error(err);
    }
}

// 3. ฟังก์ชันเริ่มหาคนคุย
async function startMatchmaking() {
    // 3.1 ขออนุญาตเปิดไมค์
    if (!localStream) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } catch (err) {
            alert('คุณต้องกด "อนุญาต" (Allow) ไมโครโฟนก่อน ถึงจะคุยได้ครับ!');
            return;
        }
    }

    // เปลี่ยนปุ่มหน้าเว็บ
    startBtn.style.display = 'none';
    skipBtn.style.display = 'block';
    stopBtn.style.display = 'block';
    statusEl.innerText = '🔍 กำลังหาคนว่าง...';
    statusEl.style.color = '#007bff';

    // 3.2 หาคนในคิว
    const { data: queue } = await supabase.from('waiting_queue').select('*').neq('user_id', user.id).limit(1);

    if (queue && queue.length > 0) {
        // เจอคนรออยู่! เราจะเป็นคนโทรไปหา (Caller)
        const partnerId = queue[0].user_id;
        
        // ลบเขาออกจากคิว เพื่อไม่ให้คนอื่นมาแย่ง
        await supabase.from('waiting_queue').delete().eq('user_id', partnerId);
        
        // เริ่มโทร
        setupWebRTC(partnerId, true);
    } else {
        // ไม่มีใครว่างเลย เราต้องไปเข้าคิวรอ (Receiver)
        await supabase.from('waiting_queue').upsert({ user_id: user.id });
        
        // รอคนอื่นโทรมา
        setupWebRTC(user.id, false);
    }
}

// 4. ฟังก์ชันเชื่อมต่อเสียง WebRTC
function setupWebRTC(roomId, isCaller) {
    // ปิดอันเก่าทิ้งก่อน (ถ้ามี)
    if (peerConnection) peerConnection.close();
    
    peerConnection = new RTCPeerConnection(rtcConfig);

    // เอาเสียงเรายัดใส่สาย
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    // เมื่อได้ยินเสียงเขา ให้เปิดออกลำโพง
    peerConnection.ontrack = (event) => {
        remoteAudio.srcObject = event.streams[0];
        statusEl.innerText = '🟢 กำลังคุยอยู่!';
        statusEl.style.color = '#28a745';
    };

    // ส่งเส้นทางเน็ต (ICE) ไปให้อีกเครื่อง
    peerConnection.onicecandidate = (event) => {
        if (event.candidate && signalingChannel) {
            signalingChannel.send({ type: 'broadcast', event: 'signal', payload: { candidate: event.candidate } });
        }
    };

    // สร้างห้องลับคุยกันผ่าน Supabase
    signalingChannel = supabase.channel(`room_${roomId}`);

    signalingChannel.on('broadcast', { event: 'signal' }, async (msg) => {
        const data = msg.payload;

        if (data.offer && !isCaller) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            signalingChannel.send({ type: 'broadcast', event: 'signal', payload: { answer: answer } });
        }
        
        if (data.answer && isCaller) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        }
        
        if (data.candidate) {
            try { await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) {}
        }
    }).subscribe(async (status) => {
        if (status === 'SUBSCRIBED' && isCaller) {
            // ถ้าเป็นคนโทร ให้สร้างสัญญาณ Offer ทันทีที่เข้าห้องสำเร็จ
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            signalingChannel.send({ type: 'broadcast', event: 'signal', payload: { offer: offer } });
        }
    });
}

// 5. ฟังก์ชันปัดเปลี่ยนคน (Skip)
async function skipMatch() {
    // ตัดสายคนเดิม
    cleanupConnection();
    
    // เอาตัวเองออกจากคิวเก่า (กันบั๊ก)
    await supabase.from('waiting_queue').delete().eq('user_id', user.id);
    
    // เริ่มหาคนใหม่ทันที
    startMatchmaking();
}

// 6. ฟังก์ชันเลิกคุย (หยุดเลย)
async function stopMatch() {
    cleanupConnection();
    await supabase.from('waiting_queue').delete().eq('user_id', user.id);
    
    startBtn.style.display = 'block';
    skipBtn.style.display = 'none';
    stopBtn.style.display = 'none';
    statusEl.innerText = 'สถานะ: รอคำสั่ง';
    statusEl.style.color = '#555';
}

// ฟังก์ชันล้างสาย
function cleanupConnection() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (signalingChannel) {
        supabase.removeChannel(signalingChannel);
        signalingChannel = null;
    }
    remoteAudio.srcObject = null;
}

// ผูกปุ่มกับฟังก์ชัน
startBtn.addEventListener('click', startMatchmaking);
skipBtn.addEventListener('click', skipMatch);
stopBtn.addEventListener('click', stopMatch);

// ให้รันทันทีที่โหลดเว็บเสร็จ
window.onload = initApp;
