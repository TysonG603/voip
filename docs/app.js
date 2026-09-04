// Basit VoIP - WebRTC (PeerJS) tabanlı, hesap/kayıt gerektirmeyen sesli arama.
// Sinyalleşme: PeerJS'in ücretsiz genel bulut sunucusu (0.peerjs.com) - hesap gerekmez.
// NAT geçişi: Google'ın ücretsiz STUN sunucuları + Open Relay Project'in ücretsiz TURN sunucuları.

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
const callBtn = $('callBtn');
const hangupBtn = $('hangupBtn');
const muteBtn = $('muteBtn');
const incomingBox = $('incomingBox');
const incomingText = $('incomingText');
const acceptBtn = $('acceptBtn');
const rejectBtn = $('rejectBtn');
const statusDot = $('statusDot');
const statusText = $('statusText');
const remoteAudio = $('remoteAudio');
const logEl = $('log');

let peer = null;
let localStream = null;
let activeCall = null;
let incomingCall = null;
let muted = false;

function log(msg) {
  const t = new Date().toLocaleTimeString();
  logEl.innerHTML = `[${t}] ${msg}<br>` + logEl.innerHTML;
  console.log(msg);
}

function setStatus(state, text) {
  statusDot.className = 'dot ' + state;
  statusText.textContent = text;
}

function resetCallUI() {
  callBtn.disabled = false;
  hangupBtn.disabled = true;
  muteBtn.disabled = true;
  incomingBox.classList.remove('show');
  activeCall = null;
  incomingCall = null;
}

async function getMic() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  return localStream;
}

function wireCall(call) {
  activeCall = call;
  call.on('stream', (remoteStream) => {
    remoteAudio.srcObject = remoteStream;
    setStatus('in-call', `Görüşme sürüyor: ${call.peer}`);
    callBtn.disabled = true;
    hangupBtn.disabled = false;
    muteBtn.disabled = false;
    incomingBox.classList.remove('show');
    log('Ses akışı bağlandı.');
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
    incomingCall = call;
    incomingText.textContent = `Gelen arama: ${call.peer}`;
    incomingBox.classList.add('show');
    setStatus('ringing', 'Gelen arama var...');
    log('Gelen arama: ' + call.peer);
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
  try {
    setStatus('connecting', 'Mikrofon isteniyor...');
    const stream = await getMic();
    setStatus('connecting', 'Aranıyor: ' + targetId);
    callBtn.disabled = true;
    const call = peer.call(targetId, stream);
    wireCall(call);
    log('Aranıyor: ' + targetId);
  } catch (err) {
    log('Mikrofon hatası: ' + err.message);
    setStatus('error', 'Mikrofon izni gerekli.');
    callBtn.disabled = false;
  }
});

acceptBtn.addEventListener('click', async () => {
  if (!incomingCall) return;
  try {
    setStatus('connecting', 'Mikrofon isteniyor...');
    const stream = await getMic();
    incomingCall.answer(stream);
    wireCall(incomingCall);
    incomingBox.classList.remove('show');
    log('Arama kabul edildi.');
  } catch (err) {
    log('Mikrofon hatası: ' + err.message);
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
});

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(myIdEl.textContent).then(() => {
    copyBtn.textContent = 'Kopyalandı';
    setTimeout(() => (copyBtn.textContent = 'Kopyala'), 1200);
  });
});

initPeer();
