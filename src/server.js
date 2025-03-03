require('dotenv').config();

// Ortam değişkenlerini yükle
process.env.NODE_ENV = 'development';
process.env.PORT = 3000;
process.env.SUPABASE_URL = 'https://unrfzoyltrqoyumrbhjo.supabase.co';
process.env.SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVucmZ6b3lsdHJxb3l1bXJiaGpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDA5NDg5NDEsImV4cCI6MjA1NjUyNDk0MX0.4p18-Ohwnerg-qUpKr4f4TQWVWKBJtSdTdmDaoTJLDE';
process.env.STUN_SERVERS = 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302';
process.env.TURN_SERVER = 'turn:openrelay.metered.ca:80';
process.env.TURN_USERNAME = 'openrelayproject';
process.env.TURN_CREDENTIAL = 'openrelayproject';

// Gerekli modülleri içe aktar
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const cookieParser = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');
const { authenticate } = require('./middleware/authMiddleware');
const adminRoutes = require('./routes/adminRoutes');
const socketService = require('./services/socketService');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');

// Supabase istemcisini oluştur
const supabaseUrl = process.env.SUPABASE_URL || 'https://unrfzoyltrqoyumrbhjo.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVucmZ6b3lsdHJxb3l1bXJiaGpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDA5NDg5NDEsImV4cCI6MjA1NjUyNDk0MX0.4p18-Ohwnerg-qUpKr4f4TQWVWKBJtSdTdmDaoTJLDE';
const supabase = createClient(supabaseUrl, supabaseKey);

// Express uygulamasını oluştur
const app = express();
const server = http.createServer(app);

// Socket.io sunucusunu oluştur
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  path: '/socket.io'
});

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));
app.use(cookieParser());

// CSP'yi tamamen kaldır
app.use((req, res, next) => {
  // Tüm CSP başlıklarını kaldır
  res.removeHeader('Content-Security-Policy');
  res.removeHeader('Content-Security-Policy-Report-Only');
  next();
});

// Sadece üretim ortamında güvenlik önlemleri
if (process.env.NODE_ENV === 'production') {
  // Helmet'i CSP olmadan kullan
  app.use(
    helmet({
      contentSecurityPolicy: false, // CSP'yi devre dışı bırak
    })
  );
} else {
  console.log('Geliştirme modunda güvenlik önlemleri kullanılmıyor');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Socket.io kimlik doğrulama middleware
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    
    if (!token) {
      return next(new Error('Kimlik doğrulama gerekli'));
    }
    
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return next(new Error('Geçersiz token'));
    }
    
    socket.user = user;
    socket.userId = user.id;
    console.log('Socket.io kimlik doğrulaması başarılı:', { userId: user.id });
    next();
  } catch (err) {
    console.error('Socket.io kimlik doğrulama hatası:', err);
    next(new Error('Kimlik doğrulama hatası'));
  }
});

// Socket.io bağlantıları
io.on('connection', (socket) => {
  console.log('Yeni bağlantı:', socket.id);
  
  // Kullanıcı ayrıldığında
  socket.on('disconnect', () => {
    console.log('Kullanıcı ayrıldı:', socket.id);
    socketService.handleDisconnect(socket, io);
  });
  
  // Diğer socket olayları
  socketService.registerSocketEvents(socket, io, supabase);
});

// Admin rotaları
app.use('/api/admin', adminRoutes);

// Ana sayfa
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Admin sayfası
app.get('/admin', async (req, res) => {
  try {
    // Admin kontrolü
    const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.redirect('/');
    }
    
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return res.redirect('/');
    }
    
    // Admin kontrolü
    const { data: adminData, error: adminError } = await supabase
      .from('admins')
      .select('*')
      .eq('user_id', user.id)
      .single();
    
    if (adminError || !adminData) {
      return res.redirect('/');
    }
    
    // Admin ise sayfayı göster
    res.sendFile(path.join(__dirname, '../public/admin.html'));
  } catch (err) {
    console.error('Admin sayfası erişim hatası:', err);
    res.redirect('/');
  }
});

// 404 sayfası
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '../public/404.html'));
});

// Socket.io bağlantı hatası yönetimi
io.on('connect_error', (err) => {
  console.error('Socket.io bağlantı hatası:', err);
});

io.on('connect_timeout', () => {
  console.error('Socket.io bağlantı zaman aşımı');
});

// Vercel için port ayarı
const PORT = process.env.PORT || 3000;

// Vercel'de çalışırken dinleme yapmayız, export ederiz
if (process.env.NODE_ENV !== 'production') {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor`);
    console.log(`Dış erişim için: http://<sunucu-ip>:${PORT}`);
  });
}

// Vercel için export
module.exports = app; 