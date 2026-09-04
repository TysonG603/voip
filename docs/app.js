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
const passphraseInput = $('passphraseInput');
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
const safetyCodeBox = $('safetyCodeBox');
const safetyCodeText = $('safetyCodeText');

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

// --- Erişim kontrolü ve kötüye kullanım koruması ---
// Şifre belirtilmişse, arama sinyali (peer.call) gelmeden önce ayrı bir DataConnection
// üzerinden zorlukdan (challenge) ispat istenir; şifre eşleşmezse gelen arama ekranda
// HİÇ gösterilmez (sessizce reddedilir). Şifre boşsa eski davranış (herkes arayabilir) korunur.
let expectingCallFrom = null; // doğrulaması geçmiş, arama beklenen peer ID
let expectingCallTimer = null;
let pendingAuthedIncomingConn = null; // doğrulanmış, arama gelince chat kanalına dönüşecek bağlantı (alıcı taraf)
let pendingAuthedConn = null; // doğrulanmış, arama sonrası chat kanalına dönüşecek bağlantı (arayan taraf)
const rejectCooldown = new Map(); // peerId -> son reddedilme zamanı (arama spam'ini önler)
const REJECT_COOLDOWN_MS = 60000;
const AUTH_TIMEOUT_MS = 8000;
const AUTH_WINDOW_MS = 60000; // doğrulama ile gerçek aramanın gelişi arasında izin verilen süre (insan tepki süresi için geniş tutuldu)

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Arayan taraf: karşı tarafa şifreyi asla açık göndermeden (nonce + şifre) hash'i gönderir.
function authenticateAsCaller(conn, passphrase) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => { conn.close(); finish(false); }, AUTH_TIMEOUT_MS);
    conn.on('open', async () => {
      const nonce = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()));
      const proof = await sha256Hex(nonce + ':' + passphrase);
      conn.send({ type: 'auth-challenge', nonce, proof });
    });
    conn.on('data', (data) => {
      if (data && data.type === 'auth-ok') finish(true);
      else if (data && data.type === 'auth-fail') { conn.close(); finish(false); }
    });
    conn.on('error', () => finish(false));
    conn.on('close', () => finish(false));
  });
}

// Alıcı taraf: kendi şifresiyle aynı hash'i üretip karşılaştırır, şifreyi hiçbir zaman iletmez.
function handleIncomingAuth(conn) {
  conn.on('data', async (data) => {
    if (!data || data.type !== 'auth-challenge') return;
    const myPassphrase = passphraseInput.value.trim();
    if (!myPassphrase) {
      conn.close();
      return;
    }
    const expected = await sha256Hex(data.nonce + ':' + myPassphrase);
    if (expected === data.proof) {
      conn.send({ type: 'auth-ok' });
      expectingCallFrom = conn.peer;
      pendingAuthedIncomingConn = conn;
      clearTimeout(expectingCallTimer);
      expectingCallTimer = setTimeout(() => {
        if (expectingCallFrom === conn.peer) {
          expectingCallFrom = null;
          pendingAuthedIncomingConn = null;
        }
      }, AUTH_WINDOW_MS);
      log('Kimlik doğrulandı: ' + conn.peer);
    } else {
      conn.send({ type: 'auth-fail' });
      setTimeout(() => conn.close(), 300); // mesajın karşıya iletilmesi için kısa bir süre bekle
      log('Yetkisiz bağlantı denemesi reddedildi (şifre uyuşmadı): ' + conn.peer);
    }
  });
}

// Görüşme kurulduktan sonra iki tarafın da bağımsız hesapladığı, sinyal sunucusu
// üzerinden değiştirilemeyen bir doğrulama kodu (WebRTC DTLS sertifika parmak izinden).
// 'stream' olayı tetiklendiği anda SDP tarafları henüz tam yerleşmemiş olabileceğinden
// (özellikle cevaplayan tarafta), birkaç kez kısa aralıklarla yeniden dener.
async function showSafetyCode(call, attemptsLeft = 6) {
  try {
    const pc = call.peerConnection;
    const extractFingerprint = (sdp) => {
      const m = sdp.match(/a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/);
      return m ? m[1] : '';
    };
    const local = pc && pc.localDescription ? extractFingerprint(pc.localDescription.sdp) : '';
    const remote = pc && pc.remoteDescription ? extractFingerprint(pc.remoteDescription.sdp) : '';
    if (!local || !remote) {
      if (attemptsLeft > 0 && call === activeCall) {
        setTimeout(() => showSafetyCode(call, attemptsLeft - 1), 400);
      }
      return;
    }
    const combined = [local, remote].sort().join('|');
    const hash = await sha256Hex(combined);
    const code = hash.slice(0, 6).toUpperCase();
    safetyCodeText.textContent = code.slice(0, 3) + '-' + code.slice(3);
    safetyCodeBox.classList.add('show');
  } catch (e) {
    // Güvenlik kodu hesaplanamadı; sessizce yok say, görüşmeyi engellemez.
  }
}

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
  safetyCodeBox.classList.remove('show');
  safetyCodeText.textContent = '------';
  activeCall = null;
  incomingCall = null;
  isCaller = false;
  muted = false;
  videoOff = false;
  pendingIncomingFile = null;
  expectingCallFrom = null;
  clearTimeout(expectingCallTimer);
  if (dataConn) {
    dataConn.close();
    dataConn = null;
  }
  if (incomingDataConn) {
    incomingDataConn.close();
    incomingDataConn = null;
  }
  if (pendingAuthedIncomingConn) {
    pendingAuthedIncomingConn.close();
    pendingAuthedIncomingConn = null;
  }
  if (pendingAuthedConn) {
    pendingAuthedConn.close();
    pendingAuthedConn = null;
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
  const onOpen = () => {
    chatPanel.classList.add('show');
    addSystemMessage('Sohbet bağlantısı kuruldu.');
    log('Sohbet/dosya kanalı açıldı: ' + conn.peer);
  };
  // Kimlik doğrulama sırasında zaten açılmış bir bağlantı yeniden kullanılıyorsa
  // 'open' olayı tekrar tetiklenmez; bu yüzden mevcut durumu da kontrol ediyoruz.
  if (conn.open) {
    onOpen();
  } else {
    conn.on('open', onOpen);
  }

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

  // PeerJS, cevaplanmamış/reddedilmiş bir aramanın kapandığını arayan tarafa her zaman
  // bildirmez (özellikle sessizce reddedildiğinde) - bu yüzden arayan taraf süresiz
  // "Aranıyor..." durumunda takılı kalmasın diye bir zaman aşımı ekliyoruz.
  let ringTimeout = null;
  if (isCaller) {
    ringTimeout = setTimeout(() => {
      if (activeCall === call) {
        log('Arama yanıtlanmadı, zaman aşımına uğradı.');
        setStatus('ready', 'Yanıt yok. Hazır - ID paylaşıp arama başlatabilirsin.');
        call.close();
        resetCallUI();
      }
    }, 30000);
  }

  call.on('stream', (remoteStream) => {
    clearTimeout(ringTimeout);
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
    showSafetyCode(call);

    // Sohbet kanalı: şifreli modda doğrulama sırasında açılan bağlantı yeniden kullanılır;
    // şifresiz modda ise arama bağlandıktan sonra yeni bir bağlantı açılır.
    if (isCaller && !dataConn) {
      if (pendingAuthedConn) {
        wireDataConnection(pendingAuthedConn);
        pendingAuthedConn = null;
      } else {
        const conn = peer.connect(call.peer, { serialization: 'binary' });
        wireDataConnection(conn);
      }
    } else if (!isCaller && !dataConn) {
      if (pendingAuthedIncomingConn) {
        wireDataConnection(pendingAuthedIncomingConn);
        pendingAuthedIncomingConn = null;
        expectingCallFrom = null;
      } else if (incomingDataConn) {
        wireDataConnection(incomingDataConn);
        incomingDataConn = null;
      }
    }
  });
  call.on('close', () => {
    clearTimeout(ringTimeout);
    log('Görüşme sonlandı.');
    setStatus('ready', 'Hazır - ID paylaşıp arama başlatabilirsin.');
    resetCallUI();
  });
  call.on('error', (err) => {
    clearTimeout(ringTimeout);
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
    const cooldownAt = rejectCooldown.get(call.peer);
    if (cooldownAt && Date.now() - cooldownAt < REJECT_COOLDOWN_MS) {
      call.close();
      return;
    }
    const myPassphrase = passphraseInput.value.trim();
    if (myPassphrase && expectingCallFrom !== call.peer) {
      // Şifre korumalı mod: önceden doğrulanmamış aramalar ekranda hiç gösterilmeden reddedilir.
      call.close();
      log('Doğrulanmamış arama sessizce reddedildi: ' + call.peer);
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
    if (conn.metadata && conn.metadata.kind === 'auth') {
      handleIncomingAuth(conn);
      return;
    }
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
  const passphrase = passphraseInput.value.trim();
  callBtn.disabled = true;
  try {
    if (passphrase) {
      setStatus('connecting', 'Kimlik doğrulanıyor...');
      const authConn = peer.connect(targetId, { serialization: 'binary', metadata: { kind: 'auth' } });
      const ok = await authenticateAsCaller(authConn, passphrase);
      if (!ok) {
        setStatus('error', 'Kimlik doğrulama başarısız (şifre uyuşmuyor veya karşı taraf yanıtlamadı).');
        callBtn.disabled = false;
        return;
      }
      pendingAuthedConn = authConn;
    }
    setStatus('connecting', 'Mikrofon' + (withVideo ? '/kamera' : '') + ' isteniyor...');
    const stream = await getMedia(withVideo);
    setStatus('connecting', 'Aranıyor: ' + targetId);
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
    rejectCooldown.set(incomingCall.peer, Date.now());
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
