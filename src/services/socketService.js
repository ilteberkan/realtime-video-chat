const { getSupabase } = require('../config/supabase');
const { createQueue } = require('./queueService');

// Kullanıcı eşleşme kuyruğu
const matchQueue = createQueue('userMatching');

// Aktif kullanıcılar ve odalar
const activeUsers = new Map();
const activeRooms = new Map();

const setupSocketHandlers = (io, supabase) => {
  io.on('connection', (socket) => {
    console.log(`Yeni bağlantı: ${socket.id}`);
    
    // Kimlik doğrulama
    socket.on('authenticate', async (token) => {
      try {
        const { data, error } = await supabase.auth.getUser(token);
        
        if (error || !data.user) {
          socket.emit('auth_error', { message: 'Kimlik doğrulama başarısız' });
          return;
        }
        
        // Kullanıcının banlı olup olmadığını kontrol et
        const { data: banData, error: banError } = await supabase
          .from('user_bans')
          .select('*')
          .eq('user_id', data.user.id)
          .gte('ban_expires_at', new Date().toISOString())
          .single();
        
        if (!banError && banData) {
          socket.emit('auth_error', { 
            message: 'Hesabınız banlandı', 
            banInfo: {
              reason: banData.reason,
              expiresAt: banData.ban_expires_at
            }
          });
          return;
        }
        
        // Kullanıcı profilini al
        const { data: profileData } = await supabase
          .from('profiles')
          .select('username')
          .eq('id', data.user.id)
          .single();
        
        // Kullanıcıyı aktif kullanıcılar listesine ekle
        activeUsers.set(socket.id, {
          id: data.user.id,
          email: data.user.email,
          username: profileData?.username || data.user.email.split('@')[0],
          inRoom: false,
          searching: false
        });
        
        console.log(`Socket.io kimlik doğrulaması başarılı:`, { userId: data.user.id });
        socket.emit('auth_success', { userId: data.user.id });
        
        // Aktivite günlüğüne ekle
        await supabase
          .from('user_activity_logs')
          .insert({
            user_id: data.user.id,
            action: 'user_connected',
            details: `Kullanıcı bağlandı: ${socket.id}`,
            created_at: new Date().toISOString()
          });
      } catch (err) {
        console.error('Kimlik doğrulama hatası:', err);
        socket.emit('auth_error', { message: 'Kimlik doğrulama sırasında bir hata oluştu' });
      }
    });
    
    // Eşleşme ara
    socket.on('find_match', async () => {
      const user = activeUsers.get(socket.id);
      
      if (!user) {
        socket.emit('error', { message: 'Kimlik doğrulaması gerekli' });
        return;
      }
      
      // Kullanıcı zaten bir odada mı kontrol et
      let userInRoom = false;
      let roomId = null;
      
      for (const [id, room] of activeRooms.entries()) {
        if (room.users.includes(socket.id)) {
          userInRoom = true;
          roomId = id;
          break;
        }
      }
      
      if (userInRoom) {
        socket.emit('error', { message: 'Zaten bir odadasınız' });
        return;
      }
      
      if (user.searching) {
        socket.emit('error', { message: 'Zaten eşleşme aranıyor' });
        return;
      }
      
      // Kullanıcının banlı olup olmadığını kontrol et
      try {
        const { data: banData, error: banError } = await supabase
          .from('user_bans')
          .select('*')
          .eq('user_id', user.id)
          .gte('ban_expires_at', new Date().toISOString())
          .single();
        
        if (!banError && banData) {
          socket.emit('error', { 
            message: 'Hesabınız banlandı', 
            banInfo: {
              reason: banData.reason,
              expiresAt: banData.ban_expires_at
            }
          });
          return;
        }
      } catch (err) {
        console.error('Ban kontrolü hatası:', err);
      }
      
      // Kullanıcıyı arama durumuna getir
      user.searching = true;
      activeUsers.set(socket.id, user);
      
      // Eşleşme ara
      const matchedSocketId = findMatch(socket.id);
      
      if (matchedSocketId) {
        // Eşleşme bulundu, oda oluştur
        const matchedUser = activeUsers.get(matchedSocketId);
        const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Kullanıcıları odaya ekle
        user.inRoom = true;
        user.searching = false;
        matchedUser.inRoom = true;
        matchedUser.searching = false;
        
        activeUsers.set(socket.id, user);
        activeUsers.set(matchedSocketId, matchedUser);
        
        // Oda bilgisini kaydet
        activeRooms.set(roomId, {
          id: roomId,
          users: [socket.id, matchedSocketId],
          startTime: Date.now()
        });
        
        // STUN/TURN sunucu bilgilerini hazırla
        const iceServers = [
          { urls: process.env.STUN_SERVERS.split(',') },
          {
            urls: process.env.TURN_SERVER,
            username: process.env.TURN_USERNAME,
            credential: process.env.TURN_CREDENTIAL
          }
        ];
        
        // Her iki kullanıcıya da eşleşme bilgisini gönder
        io.to(socket.id).emit('match_found', {
          roomId,
          peerId: matchedSocketId,
          iceServers
        });
        
        io.to(matchedSocketId).emit('match_found', {
          roomId,
          peerId: socket.id,
          iceServers
        });
        
        console.log(`Eşleşme bulundu: ${user.id} ve ${matchedUser.id}`);
        
        // Görüşme kaydını oluştur
        try {
          await supabase
            .from('calls')
            .insert({
              room_id: roomId,
              user1_id: user.id,
              user2_id: matchedUser.id,
              start_time: new Date().toISOString()
            });
        } catch (err) {
          console.error('Görüşme kaydı oluşturma hatası:', err);
        }
      } else {
        console.log(`Eşleşme aranıyor: ${user.id}`);
      }
    });
    
    // Aramayı iptal et
    socket.on('cancel_search', () => {
      const user = activeUsers.get(socket.id);
      
      if (user) {
        user.searching = false;
        activeUsers.set(socket.id, user);
        console.log(`Arama iptal edildi: ${user.id}`);
      }
    });
    
    // Odadan ayrıl
    socket.on('leave_room', ({ roomId }) => {
      const user = activeUsers.get(socket.id);
      
      if (!user) {
        return;
      }
      
      // Kullanıcı bir odada mı kontrol et
      const room = activeRooms.get(roomId);
      
      if (room) {
        // Odadaki diğer kullanıcıya bildir
        const otherSocketId = room.users.find(id => id !== socket.id);
        
        if (otherSocketId) {
          io.to(otherSocketId).emit('user_disconnected');
          
          const otherUser = activeUsers.get(otherSocketId);
          if (otherUser) {
            otherUser.inRoom = false;
            otherUser.searching = false;
            activeUsers.set(otherSocketId, otherUser);
          }
        }
        
        // Görüşme süresini hesapla ve kaydı güncelle
        const endTime = Date.now();
        const duration = Math.floor((endTime - room.startTime) / 1000); // saniye cinsinden
        
        try {
          supabase
            .from('calls')
            .update({
              end_time: new Date().toISOString(),
              duration: duration
            })
            .eq('room_id', roomId)
            .then(({ error }) => {
              if (error) {
                console.error('Görüşme kaydı güncelleme hatası:', error);
              }
            });
        } catch (err) {
          console.error('Görüşme kaydı güncelleme hatası:', err);
        }
        
        // Odayı kaldır
        activeRooms.delete(roomId);
      }
      
      // Kullanıcı durumunu güncelle
      user.inRoom = false;
      user.searching = false;
      activeUsers.set(socket.id, user);
      
      console.log(`Kullanıcı odadan ayrıldı: ${user.id}, Oda: ${roomId}`);
    });
    
    // WebRTC sinyal mesajları
    socket.on('offer', (data) => {
      const room = activeRooms.get(data.roomId);
      
      if (room) {
        const otherUser = room.users.find(id => id !== socket.id);
        if (otherUser) {
          io.to(otherUser).emit('offer', {
            offer: data.offer,
            roomId: data.roomId
          });
        }
      }
    });
    
    socket.on('answer', (data) => {
      const room = activeRooms.get(data.roomId);
      
      if (room) {
        const otherUser = room.users.find(id => id !== socket.id);
        if (otherUser) {
          io.to(otherUser).emit('answer', {
            answer: data.answer,
            roomId: data.roomId
          });
        }
      }
    });
    
    socket.on('ice_candidate', (data) => {
      const room = activeRooms.get(data.roomId);
      
      if (room) {
        const otherUser = room.users.find(id => id !== socket.id);
        if (otherUser) {
          io.to(otherUser).emit('ice_candidate', {
            candidate: data.candidate,
            roomId: data.roomId
          });
        }
      }
    });
    
    // Mesaj gönderme
    socket.on('send_message', (data) => {
      const user = activeUsers.get(socket.id);
      
      if (!user) {
        socket.emit('error', { message: 'Kimlik doğrulaması gerekli' });
        return;
      }
      
      const { roomId, message } = data;
      
      if (!roomId || !message) {
        socket.emit('error', { message: 'Oda ID ve mesaj gerekli' });
        return;
      }
      
      // Oda var mı kontrol et
      const room = activeRooms.get(roomId);
      
      if (!room) {
        socket.emit('error', { message: 'Oda bulunamadı' });
        return;
      }
      
      // Kullanıcı odada mı kontrol et
      if (!room.users.includes(socket.id)) {
        socket.emit('error', { message: 'Bu odada değilsiniz' });
        return;
      }
      
      // Odadaki diğer kullanıcıyı bul
      const otherSocketId = room.users.find(id => id !== socket.id);
      
      if (!otherSocketId) {
        socket.emit('error', { message: 'Odada başka kullanıcı yok' });
        return;
      }
      
      // Mesajı diğer kullanıcıya gönder
      io.to(otherSocketId).emit('receive_message', {
        message,
        userId: user.id,
        username: user.username || 'Eşleşme'
      });
      
      console.log(`Mesaj gönderildi: ${user.id} -> ${roomId}, Mesaj: ${message}`);
    });
    
    // Beğeni/Beğenmeme
    socket.on('like_user', async (data) => {
      const user = activeUsers.get(socket.id);
      const room = activeRooms.get(data.roomId);
      
      if (!user || !room) return;
      
      const otherSocketId = room.users.find(id => id !== socket.id);
      const otherUser = activeUsers.get(otherSocketId);
      
      if (!otherUser) return;
      
      // Beğeniyi kaydet
      try {
        await supabase
          .from('user_likes')
          .insert({
            user_id: user.id,
            liked_user_id: otherUser.id,
            created_at: new Date().toISOString()
          });
        
        // Diğer kullanıcıya bildir
        io.to(otherSocketId).emit('user_liked', {
          userId: user.id
        });
      } catch (err) {
        console.error('Beğeni kaydetme hatası:', err);
      }
    });
    
    socket.on('dislike_user', async (data) => {
      const user = activeUsers.get(socket.id);
      const room = activeRooms.get(data.roomId);
      
      if (!user || !room) return;
      
      const otherSocketId = room.users.find(id => id !== socket.id);
      const otherUser = activeUsers.get(otherSocketId);
      
      if (!otherUser) return;
      
      // Diğer kullanıcıya bildir
      io.to(otherSocketId).emit('user_disliked', {
        userId: user.id
      });
    });
    
    // Görüşmeyi sonlandır
    socket.on('end_call', async (data) => {
      const room = activeRooms.get(data.roomId);
      
      if (room) {
        const otherUser = room.users.find(id => id !== socket.id);
        const user = activeUsers.get(socket.id);
        
        if (otherUser) {
          io.to(otherUser).emit('call_ended');
          
          const otherUserData = activeUsers.get(otherUser);
          if (otherUserData) {
            otherUserData.inRoom = false;
            activeUsers.set(otherUser, otherUserData);
          }
        }
        
        if (user) {
          user.inRoom = false;
          activeUsers.set(socket.id, user);
        }
        
        // Görüşme süresini hesapla ve kaydı güncelle
        const endTime = Date.now();
        const duration = Math.floor((endTime - room.startTime) / 1000); // saniye cinsinden
        
        try {
          await supabase
            .from('calls')
            .update({
              end_time: new Date().toISOString(),
              duration: duration
            })
            .eq('room_id', data.roomId);
        } catch (err) {
          console.error('Görüşme kaydı güncelleme hatası:', err);
        }
        
        // Odayı kaldır
        activeRooms.delete(data.roomId);
      }
    });
    
    // Bağlantı kesildiğinde
    socket.on('disconnect', async () => {
      const user = activeUsers.get(socket.id);
      if (user) {
        // Kullanıcı bir odadaysa, diğer kullanıcıya bildir
        if (user.inRoom) {
          // Kullanıcının olduğu odayı bul
          for (const [roomId, room] of activeRooms.entries()) {
            if (room.users.includes(socket.id)) {
              // Odadaki diğer kullanıcıya bildir
              const otherSocketId = room.users.find(id => id !== socket.id);
              if (otherSocketId) {
                io.to(otherSocketId).emit('user_disconnected');
                
                const otherUser = activeUsers.get(otherSocketId);
                if (otherUser) {
                  otherUser.inRoom = false;
                  otherUser.searching = false;
                  activeUsers.set(otherSocketId, otherUser);
                }
              }
              
              // Görüşme süresini hesapla ve kaydı güncelle
              const endTime = Date.now();
              const duration = Math.floor((endTime - room.startTime) / 1000); // saniye cinsinden
              
              try {
                await supabase
                  .from('calls')
                  .update({
                    end_time: new Date().toISOString(),
                    duration: duration
                  })
                  .eq('room_id', roomId);
              } catch (err) {
                console.error('Görüşme kaydı güncelleme hatası:', err);
              }
              
              // Odayı kaldır
              activeRooms.delete(roomId);
              break;
            }
          }
        }
        
        // Aktivite günlüğüne ekle
        try {
          await supabase
            .from('user_activity_logs')
            .insert({
              user_id: user.id,
              action: 'user_disconnected',
              details: `Kullanıcı bağlantısı kesildi: ${socket.id}`,
              created_at: new Date().toISOString()
            });
        } catch (err) {
          console.error('Aktivite günlüğü ekleme hatası:', err);
        }
        
        // Kullanıcıyı aktif kullanıcılar listesinden kaldır
        activeUsers.delete(socket.id);
      }
      
      console.log(`Kullanıcı ayrıldı: ${socket.id}`);
    });
  });
  
  // Eşleşme kuyruğu işleyicisi
  matchQueue.process('findMatch', async (job) => {
    const { userId, socketId } = job.data;
    
    // Kullanıcı hala bağlı mı kontrol et
    const user = activeUsers.get(socketId);
    if (!user || !user.searching) {
      return { success: false, reason: 'Kullanıcı artık arama yapmıyor' };
    }
    
    // Eşleşme için uygun kullanıcı ara
    let matchedUser = null;
    let matchedSocketId = null;
    
    for (const [otherSocketId, otherUser] of activeUsers.entries()) {
      if (otherSocketId !== socketId && otherUser.searching && !otherUser.inRoom) {
        matchedUser = otherUser;
        matchedSocketId = otherSocketId;
        break;
      }
    }
    
    if (matchedUser) {
      // Eşleşme bulundu, oda oluştur
      const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Kullanıcıları odaya ekle
      user.inRoom = true;
      user.searching = false;
      matchedUser.inRoom = true;
      matchedUser.searching = false;
      
      activeUsers.set(socketId, user);
      activeUsers.set(matchedSocketId, matchedUser);
      
      // Oda bilgisini kaydet
      activeRooms.set(roomId, {
        id: roomId,
        users: [socketId, matchedSocketId],
        startTime: Date.now()
      });
      
      // STUN/TURN sunucu bilgilerini hazırla
      const iceServers = [
        { urls: process.env.STUN_SERVERS.split(',') },
        {
          urls: process.env.TURN_SERVER,
          username: process.env.TURN_USERNAME,
          credential: process.env.TURN_CREDENTIAL
        }
      ];
      
      // Her iki kullanıcıya da eşleşme bilgisini gönder
      io.to(socketId).emit('match_found', {
        roomId,
        peerId: matchedSocketId,
        iceServers
      });
      
      io.to(matchedSocketId).emit('match_found', {
        roomId,
        peerId: socketId,
        iceServers
      });
      
      console.log(`Eşleşme bulundu: ${userId} ve ${matchedUser.id}`);
      
      return { success: true, roomId };
    } else {
      // Eşleşme bulunamadı, kullanıcıyı tekrar kuyruğa ekle
      setTimeout(async () => {
        const currentUser = activeUsers.get(socketId);
        if (currentUser && currentUser.searching) {
          await matchQueue.add('findMatch', { userId, socketId }, { delay: 2000 });
        }
      }, 1000);
      
      return { success: false, reason: 'Eşleşme bulunamadı' };
    }
  });
};

// Eşleşme bul
function findMatch(socketId) {
  const user = activeUsers.get(socketId);
  
  if (!user || !user.searching) {
    return null;
  }
  
  for (const [id, otherUser] of activeUsers.entries()) {
    if (id !== socketId && otherUser.searching && !otherUser.inRoom) {
      return id;
    }
  }
  
  return null;
}

module.exports = { setupSocketHandlers }; 