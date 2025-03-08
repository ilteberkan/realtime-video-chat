require('dotenv').config();

// Ortam değişkenlerini yükle
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unrfzoyltrqoyumrbhjo.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVucmZ6b3lsdHJxb3l1bXJiaGpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDA5NDg5NDEsImV4cCI6MjA1NjUyNDk0MX0.4p18-Ohwnerg-qUpKr4f4TQWVWKBJtSdTdmDaoTJLDE';
const STUN_SERVERS = process.env.STUN_SERVERS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302';
const TURN_SERVER = process.env.TURN_SERVER || 'turn:openrelay.metered.ca:80';
const TURN_USERNAME = process.env.TURN_USERNAME || 'openrelayproject';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || 'openrelayproject';

// Gerekli modülleri içe aktar
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Server } = require('socket.io');

// Supabase istemcisini oluştur
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Express uygulamasını oluştur
const app = express();
const server = http.createServer(app);

// Socket.io sunucusunu oluştur
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000
});

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Eşleşme kuyruğu ve aktif eşleşmeler
const matchQueue = [];
const activeMatches = new Map();

// Kullanıcı socket'lerini saklamak için Map
const userSockets = new Map();
const activeRooms = new Map();
const pendingMatches = new Map();

// Son eşleşmeleri saklamak için Map (kullanıcı çiftleri ve eşleşme zamanı)
const recentMatches = new Map();

// Eşleşme endpoint'leri
// Eşleşme başlat
app.post('/api/match', async (req, res) => {
  try {
    const { userId, email } = req.body;
    
    // Kullanıcı zaten kuyrukta mı kontrol et
    const existingUser = matchQueue.find(user => user.userId === userId);
    if (existingUser) {
      return res.json({ status: 'already-in-queue', queuePosition: matchQueue.indexOf(existingUser) + 1 });
    }
    
    // Aktif eşleşmesi var mı kontrol et
    for (const [roomId, match] of activeMatches.entries()) {
      if (match.user1.userId === userId || match.user2?.userId === userId) {
        // Eşleşmenin geçerli olduğundan emin ol
        if (!match.user2 || !match.user2.userId) {
          // Geçersiz eşleşme, temizle
          activeMatches.delete(roomId);
          continue;
        }
        
        return res.json({ 
          status: 'matched',
          roomId,
          peerId: match.user1.userId === userId ? match.user2?.userId : match.user1.userId,
          peerEmail: match.user1.userId === userId ? match.user2?.email : match.user1.email,
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        });
      }
    }
    
    // Kuyrukta bekleyen kullanıcı var mı kontrol et
    if (matchQueue.length > 0) {
      // Kendisiyle eşleşmesini önle
      const availablePeers = matchQueue.filter(peer => {
        // Kendisiyle eşleşmeyi önle
        if (peer.userId === userId) return false;
        
        // Son eşleşme zamanını kontrol et
        const matchKey = [userId, peer.userId].sort().join('-');
        const lastMatchTime = recentMatches.get(matchKey);
        
        // Son 60 saniye içinde eşleşme varsa filtrele
        if (lastMatchTime && (Date.now() - lastMatchTime) < 60000) {
          console.log(`Son 60 saniye içinde eşleşme: ${userId} ve ${peer.userId}`);
          return false;
        }
        
        return true;
      });
      
      if (availablePeers.length > 0) {
        // Rastgele bir kullanıcı seç
        const randomIndex = Math.floor(Math.random() * availablePeers.length);
        const peer = availablePeers[randomIndex];
        
        // Kullanıcıyı kuyruktan çıkar
        const peerIndex = matchQueue.findIndex(u => u.userId === peer.userId);
        if (peerIndex !== -1) {
          matchQueue.splice(peerIndex, 1);
        }
        
        // Oda oluştur
        const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Eşleşmeyi kaydet
        activeMatches.set(roomId, {
          user1: { userId, email },
          user2: { userId: peer.userId, email: peer.email },
          startTime: Date.now()
        });
        
        // Odayı kaydet
        activeRooms.set(roomId, {
          id: roomId,
          users: [userId, peer.userId],
          startTime: Date.now()
        });
        
        // Son eşleşmeyi kaydet
        const matchKey = [userId, peer.userId].sort().join('-');
        recentMatches.set(matchKey, Date.now());
        
        // 60 saniye sonra son eşleşmeyi temizle
        setTimeout(() => {
          recentMatches.delete(matchKey);
        }, 60000);
        
        console.log(`Eşleşme bulundu: ${userId} ve ${peer.userId}`);
        
        // Diğer kullanıcıya bildirim gönder
        const peerSocket = userSockets.get(peer.userId);
        if (peerSocket) {
          peerSocket.emit('match-found', {
            roomId,
            peerId: userId,
            peerEmail: email,
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' }
            ]
          });
        }
        
        return res.json({
          status: 'matched',
          roomId,
          peerId: peer.userId,
          peerEmail: peer.email,
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        });
      }
    }
    
    // Eşleşme bulunamadı, kuyruğa ekle
    matchQueue.push({ userId, email });
    console.log(`Kullanıcı kuyruğa eklendi: ${userId}`);
    
    // Kullanıcıya bildirim gönder
    const userSocket = userSockets.get(userId);
    if (userSocket) {
      userSocket.emit('queued', { 
        status: 'queued', 
        queuePosition: matchQueue.length 
      });
    }
    
    return res.json({ status: 'queued', queuePosition: matchQueue.length });
  } catch (err) {
    console.error('Eşleşme hatası:', err);
    res.status(500).json({ error: 'Eşleşme sırasında bir hata oluştu' });
  }
});

// Eşleşme durumu kontrol et
app.post('/api/match/status', async (req, res) => {
  try {
    const { userId } = req.body;
    
    // Aktif eşleşmesi var mı kontrol et
    for (const [roomId, match] of activeMatches.entries()) {
      if (match.user1.userId === userId || match.user2?.userId === userId) {
        // Eşleşmenin geçerli olduğundan emin ol
        if (!match.user2 || !match.user2.userId) {
          // Geçersiz eşleşme, temizle
          activeMatches.delete(roomId);
          continue;
        }
        
        return res.json({ 
          status: 'matched',
          roomId,
          peerId: match.user1.userId === userId ? match.user2?.userId : match.user1.userId,
          peerEmail: match.user1.userId === userId ? match.user2?.email : match.user1.email,
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        });
      }
    }
    
    // Kullanıcı kuyrukta mı kontrol et
    const queuePosition = matchQueue.findIndex(user => user.userId === userId);
    
    if (queuePosition !== -1) {
      return res.json({ status: 'queued', queuePosition: queuePosition + 1 });
    }
    
    // Kullanıcı ne kuyrukta ne de eşleşmede
    return res.json({ status: 'not-found' });
  } catch (err) {
    console.error('Eşleşme durumu kontrolü hatası:', err);
    res.status(500).json({ error: 'Eşleşme durumu kontrolü sırasında bir hata oluştu' });
  }
});

// Eşleşme iptal et
app.post('/api/match/cancel', async (req, res) => {
  try {
    const { userId } = req.body;
    
    // Kullanıcıyı kuyruktan çıkar
    const userQueueIndex = matchQueue.findIndex(u => u.userId === userId);
    if (userQueueIndex !== -1) {
      matchQueue.splice(userQueueIndex, 1);
      console.log('Kullanıcı kuyruktan çıkarıldı (iptal):', userId);
    }
    
    res.json({ status: 'success' });
  } catch (err) {
    console.error('Eşleşme iptal hatası:', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Socket.io bağlantıları
io.on('connection', (socket) => {
  console.log('Yeni bağlantı:', socket.id);
  
  // Kullanıcı bilgisini ayarla
  socket.on('set-user', (user) => {
    socket.user = user;
    userSockets.set(user.id, socket);
    console.log('Kullanıcı bilgisi ayarlandı:', user.id);
  });
  
  // Odaya katıl
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    console.log('Odaya katıldı:', roomId);
  });
  
  // WebRTC sinyalleri
  socket.on('offer', (data) => {
    socket.to(data.roomId).emit('offer', data);
  });
  
  socket.on('answer', (data) => {
    socket.to(data.roomId).emit('answer', data);
  });
  
  socket.on('ice-candidate', (data) => {
    socket.to(data.roomId).emit('ice-candidate', data);
  });
  
  // Video durumu değişikliği
  socket.on('video-status', (data) => {
    socket.to(data.roomId).emit('video-status', {
      isVideoOff: data.isVideoOff,
      userId: socket.user?.id
    });
  });
  
  // Ses durumu değişikliği
  socket.on('audio-status', (data) => {
    socket.to(data.roomId).emit('audio-status', {
      isMuted: data.isMuted,
      userId: socket.user?.id
    });
  });
  
  // Mesaj gönder
  socket.on('send-message', (data) => {
    const { roomId, message } = data;
    
    if (!socket.user) {
      console.log('Kullanıcı bilgisi olmadan mesaj gönderilmeye çalışıldı');
      return;
    }
    
    const messageData = {
      userId: socket.user.id,
      email: socket.user.email,
      message,
      timestamp: Date.now()
    };
    
    // Odadaki diğer kullanıcılara mesajı gönder
    socket.to(roomId).emit('receive-message', messageData);
  });
  
  // Bağlantı koptuğunda
  socket.on('disconnect', () => {
    console.log('Bağlantı koptu:', socket.id);
    
    // Kullanıcı ID'sini bul
    const userId = socket.user?.id;
    if (userId) {
      // Kullanıcıyı socket listesinden çıkar
      userSockets.delete(userId);
      
      // Kullanıcıyı kuyruktan çıkar
      const userQueueIndex = matchQueue.findIndex(u => u.userId === userId);
      if (userQueueIndex !== -1) {
        matchQueue.splice(userQueueIndex, 1);
        console.log('Kullanıcı kuyruktan çıkarıldı (bağlantı koptu):', userId);
      }
      
      // Kullanıcının aktif eşleşmelerini bul ve temizle
      for (const [roomId, match] of activeMatches.entries()) {
        if (match.user1.userId === userId || match.user2?.userId === userId) {
          // Diğer kullanıcıyı bul
          const otherUserId = match.user1.userId === userId ? match.user2?.userId : match.user1.userId;
          
          // Diğer kullanıcıya bildirim gönder
          const otherUserSocket = userSockets.get(otherUserId);
          if (otherUserSocket) {
            otherUserSocket.emit('call-ended', { 
              roomId,
              endedBy: userId,
              reason: 'disconnected',
              autoRequeue: false // Diğer kullanıcı otomatik olarak sıraya girmesin
            });
          }
          
          // Eşleşmeyi sil
          activeMatches.delete(roomId);
          console.log('Eşleşme sonlandırıldı (bağlantı koptu):', roomId);
        }
      }
    }
  });
});

// Test endpoint'i
app.get('/api/test', (req, res) => {
  console.log('Test endpoint çağrıldı');
  res.json({ message: 'Test başarılı', timestamp: Date.now() });
});

// Ana sayfa
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// 404 sayfası
app.use((req, res) => {
  try {
    console.log('404 - Sayfa bulunamadı:', req.url);
    res.status(404).sendFile(path.join(__dirname, '../public/404.html'));
  } catch (err) {
    console.error('404 sayfası gösterilirken hata:', err);
    res.status(404).send('Sayfa bulunamadı');
  }
});

// Sunucuyu başlat
server.listen(PORT, () => {
  console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor`);
});

// Vercel için export
module.exports = app;

// Eşleşme algoritmasını optimize et
const matchUsers = () => {
  try {
    while (matchQueue.length >= 2) {
      const user1 = matchQueue.shift();
      let partnerIndex = matchQueue.findIndex(u => u.userId !== user1.userId);
      
      if (partnerIndex === -1) {
        matchQueue.push(user1);
        console.log('Eşleşecek kullanıcı bulunamadı:', user1.userId);
        return;
      }
      
      const user2 = matchQueue.splice(partnerIndex, 1)[0];
      console.log(`Eşleşme tamamlandı: ${user1.userId} ↔ ${user2.userId}`);
      
      // Oda ve ICE konfigürasyonu
      const roomId = `room_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const iceConfig = [
        { urls: STUN_SERVERS.split(',') },
        { urls: TURN_SERVER, username: TURN_USERNAME, credential: TURN_CREDENTIAL }
      ];
      
      // Her iki kullanıcıya bildirim gönder
      [user1, user2].forEach((user, index) => {
        const partner = index === 0 ? user2 : user1;
        const socket = userSockets.get(user.userId);
        
        const matchData = {
          status: 'matched',
          roomId,
          peerId: partner.userId,
          peerEmail: partner.email,
          iceServers: iceConfig
        };
        
        if (socket) {
          socket.emit('match-found', matchData);
          console.log(`Canlı bildirim: ${user.userId}`);
        } else {
          activeMatches.set(roomId, {
            user1: { userId: user.userId, email: user.email },
            user2: { userId: partner.userId, email: partner.email },
            startTime: Date.now()
          });
          console.log(`Bekleyen eşleşme: ${user.userId}`);
        }
      });
      
      // Odayı kaydet
      activeRooms.set(roomId, {
        id: roomId,
        users: [user1.userId, user2.userId],
        createdAt: Date.now(),
        lastActivity: Date.now()
      });
    }
  } catch (err) {
    console.error('Eşleşme hatası:', err);
  }
};

// Her 2 saniyede bir eşleştirme yap
setInterval(matchUsers, 2000);

// Görüşme sonlandırma endpoint'i
app.post('/api/end-call', async (req, res) => {
  try {
    const userId = req.body.userId;
    const roomId = req.body.roomId;
    const autoRequeue = req.body.autoRequeue || false;
    
    // Odayı temizle
    if (roomId && activeRooms.has(roomId)) {
      const room = activeRooms.get(roomId);
      
      // Diğer kullanıcıyı bul
      const otherUserId = room.users.find(id => id !== userId);
      
      // Eşleşmeyi bul
      let matchToRemove = null;
      for (const [matchRoomId, match] of activeMatches.entries()) {
        if (matchRoomId === roomId) {
          matchToRemove = match;
          break;
        }
      }
      
      // Aktif eşleşmeleri temizle
      activeMatches.delete(roomId);
      
      // Tüm aktif eşleşmelerde kullanıcıyı ara ve temizle
      for (const [matchRoomId, match] of activeMatches.entries()) {
        if (match.user1.userId === userId || match.user2?.userId === userId) {
          activeMatches.delete(matchRoomId);
        }
      }
      
      // Odayı sil
      activeRooms.delete(roomId);
      
      // Diğer kullanıcıya bildirim gönder
      const otherUserSocket = userSockets.get(otherUserId);
      if (otherUserSocket) {
        otherUserSocket.emit('call-ended', { 
          roomId,
          endedBy: userId,
          autoRequeue: false // Diğer kullanıcı otomatik olarak sıraya girmesin
        });
      }
      
      // Eşleşmedeki diğer kullanıcıyı da kuyruktan çıkar
      if (matchToRemove) {
        const otherUserInMatch = matchToRemove.user1.userId === userId ? matchToRemove.user2.userId : matchToRemove.user1.userId;
        const otherUserQueueIndex = matchQueue.findIndex(u => u.userId === otherUserInMatch);
        if (otherUserQueueIndex !== -1) {
          matchQueue.splice(otherUserQueueIndex, 1);
          console.log('Eşleşmedeki diğer kullanıcı kuyruktan çıkarıldı:', otherUserInMatch);
        }
      }
      
      // Otomatik eşleşme isteği varsa kuyruğa ekle, yoksa kuyruktan çıkar
      if (autoRequeue) {
        // Kullanıcı zaten kuyrukta mı kontrol et
        const existingUser = matchQueue.find(u => u.userId === userId);
        if (!existingUser) {
          // Kullanıcı bilgilerini al
          const userSocket = userSockets.get(userId);
          const userEmail = userSocket?.user?.email || 'unknown@example.com';
          
          // Kuyruğa ekle
          matchQueue.push({ userId, email: userEmail });
          console.log('Kullanıcı otomatik olarak kuyruğa eklendi:', userId);
          
          // Kullanıcıya bildirim gönder
          if (userSocket) {
            userSocket.emit('queued', { 
              status: 'queued', 
              queuePosition: matchQueue.length 
            });
          }
        }
      } else {
        // Kullanıcıyı kuyruktan çıkar
        const userQueueIndex = matchQueue.findIndex(u => u.userId === userId);
        if (userQueueIndex !== -1) {
          matchQueue.splice(userQueueIndex, 1);
          console.log('Kullanıcı kuyruktan çıkarıldı:', userId);
        }
      }
    }
    
    res.json({ status: 'success' });
  } catch (err) {
    console.error('Görüşme sonlandırma hatası:', err);
    res.status(500).json({ error: 'Görüşme sonlandırma sırasında bir hata oluştu' });
  }
}); 