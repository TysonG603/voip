// Basit VoIP - WebRTC (PeerJS) tabanlı, hesap/kayıt gerektirmeyen sesli/görüntülü arama + sohbet.
// Sinyalleşme: PeerJS'in ücretsiz genel bulut sunucusu (0.peerjs.com) - hesap gerekmez.
// NAT geçişi: Google'ın ücretsiz STUN sunucuları + Open Relay Project'in ücretsiz TURN sunucuları.
// Sohbet/dosya: aynı P2P bağlantı üzerinden WebRTC DataChannel (PeerJS DataConnection), ekstra sunucu yok.

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

const $ = (id) => document.getElementById(id);
const myIdEl = $('myId');
const copyBtn = $('copyBtn');
const peerIdInput = $('peerIdInput');
const videoCheckbox = $('videoCheckbox');
const callBtn = $('callBtn');
const hangupBtn = $('hangupBtn');
const muteBtn = $('muteBtn');
const videoToggleBtn = $('videoToggleBtn');
const incomingBox = $('incomingBox');
const incomingText = $('incomingText');
const acceptBtn = $('acceptBtn');
const rejectBtn = $('rejectBtn');
const statusDot = $('statusDot');
const statusText = $('statusText');
const logEl = $('log');
const videoArea = $('videoArea');
const remoteVideo = $('remoteVideo');
const localVideo = $('localVideo');
const chatPanel = $('chatPanel');
const chatMessages = $('chatMessages');
const chatInput = $('chatInput');
const sendBtn = $('sendBtn');
const fileBtn = $('fileBtn');
const fileInput = $('fileInput');

let peer = null;
let localStream = null;
let activeCall = null;
let incomingCall = null;
let incomingDataConn = null; // gelen arama kabul edilmeden önce chat bağlantısı gelirse burada bekler
let dataConn = null;
let isCaller = false;
let muted = false;
let videoOff = false;
let pendingIncomingFile = null;

function log(msg) {
  const t = new Date().toLocaleTimeString();
  logEl.innerHTML = `[${t}] ${msg}<br>` + logEl.innerHTML;
  console.log(msg);
}

function setStatus(state, text) {
  statusDot.className = 'dot ' + state;
  statusText.textContent = text;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function resetCallUI() {
  callBtn.disabled = false;
  hangupBtn.disabled = true;
  muteBtn.disabled = true;
  muteBtn.textContent = 'Sessiz';
  muteBtn.classList.remove('active');
  videoToggleBtn.disabled = true;
  videoToggleBtn.textContent = 'Kamera';
  videoToggleBtn.classList.remove('active');
  incomingBox.classList.remove('show');
  videoArea.className = 'video-area';
  remoteVideo.srcObject = null;
  localVideo.srcObject = null;
  chatPanel.classList.remove('show');
  chatMessages.innerHTML = '';
  activeCall = null;
  incomingCall = null;
  isCaller = false;
  muted = false;
  videoOff = false;
  pendingIncomingFile = null;
  if (dataConn) {
    dataConn.close();
    dataConn = null;
  }
  if (incomingDataConn) {
    incomingDataConn.close();
    incomingDataConn = null;
  }
}

async function getMedia(withVideo) {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
  return localStream;
}

function addChatMessage(text, fromMe) {
  const div = document.createElement('div');
  div.className = 'msg' + (fromMe ? ' me' : '');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  div.appendChild(bubble);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addChatFile(name, size, url, fromMe) {
  const div = document.createElement('div');
  div.className = 'msg' + (fromMe ? ' me' : '');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.target = '_blank';
  link.textContent = `📎 ${name}`;
  bubble.appendChild(link);
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = formatBytes(size);
  bubble.appendChild(meta);
  div.appendChild(bubble);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.style.textAlign = 'center';
  div.style.fontSize = '11px';
  div.style.color = 'var(--text-dim)';
  div.style.margin = '6px 0';
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function wireDataConnection(conn) {
  dataConn = conn;
  conn.on('open', () => {
    chatPanel.classList.add('show');
    addSystemMessage('Sohbet bağlantısı kuruldu.');
    log('Sohbet/dosya kanalı açıldı: ' + conn.peer);
  });

  conn.on('data', (data) => {
    if (data && typeof data === 'object' && !(data instanceof ArrayBuffer) && !(data instanceof Blob) && data.type) {
      if (data.type === 'chat') {
        addChatMessage(data.text, false);
      } else if (data.type === 'file-meta') {
        pendingIncomingFile = { name: data.name, size: data.size, mime: data.mime };
      }
      return;
    }
    // Ham dosya verisi (ArrayBuffer/Blob) - önceki file-meta mesajıyla eşleştir.
    if (pendingIncomingFile) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: pendingIncomingFile.mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      addChatFile(pendingIncomingFile.name, pendingIncomingFile.size, url, false);
      pendingIncomingFile = null;
    }
  });

  conn.on('close', () => {
    log('Sohbet/dosya kanalı kapandı.');
    chatPanel.classList.remove('show');
    if (dataConn === conn) dataConn = null;
  });

  conn.on('error', (err) => log('Sohbet kanalı hatası: ' + err));
}

function wireCall(call, withVideo) {
  activeCall = call;
  call.on('stream', (remoteStream) => {
    remoteVideo.srcObject = remoteStream;
    const hasRemoteVideo = remoteStream.getVideoTracks().length > 0;
    const hasLocalVideo = localStream && localStream.getVideoTracks().length > 0;

    if (hasLocalVideo) {
      localVideo.srcObject = localStream;
    }
    videoArea.className = 'video-area show' + (hasRemoteVideo ? '' : ' audio-only') + (hasLocalVideo ? '' : ' no-local');

    setStatus('in-call', `Görüşme sürüyor: ${call.peer}`);
    callBtn.disabled = true;
    hangupBtn.disabled = false;
    muteBtn.disabled = false;
    videoToggleBtn.disabled = !hasLocalVideo;
    incomingBox.classList.remove('show');
    log('Ses/görüntü akışı bağlandı.');

    // Sohbet kanalını sadece arayan taraf açar, karşı taraf peer.on('connection') ile alır.
    if (isCaller && !dataConn) {
      const conn = peer.connect(call.peer, { serialization: 'binary' });
      wireDataConnection(conn);
    } else if (!isCaller && incomingDataConn) {
      wireDataConnection(incomingDataConn);
      incomingDataConn = null;
    }
  });
  call.on('close', () => {
    log('Görüşme sonlandı.');
    setStatus('ready', 'Hazır - ID paylaşıp arama başlatabilirsin.');
    resetCallUI();
  });
  call.on('error', (err) => {
    log('Görüşme hatası: ' + err);
    setStatus('error', 'Görüşme hatası: ' + err.message);
    resetCallUI();
  });
}

function initPeer() {
  peer = new Peer({
    config: { iceServers: ICE_SERVERS },
  });

  peer.on('open', (id) => {
    myIdEl.textContent = id;
    setStatus('ready', 'Hazır - ID paylaşıp arama başlatabilirsin.');
    log('Sinyal sunucusuna bağlanıldı. ID: ' + id);
  });

  peer.on('call', async (call) => {
    if (activeCall) {
      call.close();
      return;
    }
    isCaller = false;
    incomingCall = call;
    incomingText.textContent = `Gelen arama: ${call.peer}`;
    incomingBox.classList.add('show');
    setStatus('ringing', 'Gelen arama var...');
    log('Gelen arama: ' + call.peer);
  });

  peer.on('connection', (conn) => {
    // Karşı taraf henüz aramayı kabul etmediysek bağlantıyı arama kabul edilene kadar sakla.
    if (activeCall && !isCaller) {
      wireDataConnection(conn);
    } else {
      incomingDataConn = conn;
    }
  });

  peer.on('disconnected', () => {
    setStatus('connecting', 'Bağlantı koptu, yeniden bağlanılıyor...');
    log('Sinyal sunucusu bağlantısı koptu, tekrar deneniyor.');
    setTimeout(() => { if (peer && !peer.destroyed) peer.reconnect(); }, 1000);
  });

  peer.on('error', (err) => {
    log('Peer hatası: ' + err.type + ' ' + (err.message || ''));
    if (err.type === 'peer-unavailable') {
      setStatus('ready', 'Belirtilen ID bulunamadı veya çevrimdışı.');
      resetCallUI();
    } else {
      setStatus('error', 'Hata: ' + err.type);
    }
  });
}

callBtn.addEventListener('click', async () => {
  const targetId = peerIdInput.value.trim();
  if (!targetId) {
    alert('Aramak istediğin ID\'yi gir.');
    return;
  }
  const withVideo = videoCheckbox.checked;
  try {
    setStatus('connecting', 'Mikrofon' + (withVideo ? '/kamera' : '') + ' isteniyor...');
    const stream = await getMedia(withVideo);
    setStatus('connecting', 'Aranıyor: ' + targetId);
    callBtn.disabled = true;
    isCaller = true;
    const call = peer.call(targetId, stream);
    wireCall(call, withVideo);
    log('Aranıyor: ' + targetId);
  } catch (err) {
    log('Mikrofon/kamera hatası: ' + err.message);
    setStatus('error', 'Mikrofon/kamera izni gerekli.');
    callBtn.disabled = false;
  }
});

acceptBtn.addEventListener('click', async () => {
  if (!incomingCall) return;
  const withVideo = videoCheckbox.checked;
  try {
    setStatus('connecting', 'Mikrofon' + (withVideo ? '/kamera' : '') + ' isteniyor...');
    const stream = await getMedia(withVideo);
    incomingCall.answer(stream);
    wireCall(incomingCall, withVideo);
    incomingBox.classList.remove('show');
    log('Arama kabul edildi.');
  } catch (err) {
    log('Mikrofon/kamera hatası: ' + err.message);
    incomingCall.close();
    resetCallUI();
  }
});

rejectBtn.addEventListener('click', () => {
  if (incomingCall) {
    incomingCall.close();
    log('Arama reddedildi.');
  }
  resetCallUI();
  setStatus('ready', 'Hazır - ID paylaşıp arama başlatabilirsin.');
});

hangupBtn.addEventListener('click', () => {
  if (activeCall) {
    activeCall.close();
  }
  resetCallUI();
  setStatus('ready', 'Hazır - ID paylaşıp arama başlatabilirsin.');
  log('Görüşme kapatıldı.');
});

muteBtn.addEventListener('click', () => {
  if (!localStream) return;
  muted = !muted;
  localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  muteBtn.textContent = muted ? 'Sesi Aç' : 'Sessiz';
  muteBtn.classList.toggle('active', muted);
});

videoToggleBtn.addEventListener('click', () => {
  if (!localStream || localStream.getVideoTracks().length === 0) return;
  videoOff = !videoOff;
  localStream.getVideoTracks().forEach((t) => (t.enabled = !videoOff));
  videoToggleBtn.textContent = videoOff ? 'Kamerayı Aç' : 'Kamerayı Kapat';
  videoToggleBtn.classList.toggle('active', videoOff);
  videoArea.classList.toggle('no-local', videoOff);
});

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(myIdEl.textContent).then(() => {
    copyBtn.textContent = 'Kopyalandı';
    setTimeout(() => (copyBtn.textContent = 'Kopyala'), 1200);
  });
});

function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text || !dataConn) return;
  dataConn.send({ type: 'chat', text });
  addChatMessage(text, true);
  chatInput.value = '';
}

sendBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChatMessage();
});

fileBtn.addEventListener('click', () => {
  if (!dataConn) return;
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file || !dataConn) return;
  dataConn.send({ type: 'file-meta', name: file.name, size: file.size, mime: file.type });
  dataConn.send(file);
  const url = URL.createObjectURL(file);
  addChatFile(file.name, file.size, url, true);
  log('Dosya gönderildi: ' + file.name);
});

initPeer();
