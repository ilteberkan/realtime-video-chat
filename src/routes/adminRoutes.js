const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { authenticateAdmin } = require('../middleware/authMiddleware');

// Supabase istemcisini oluştur
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Admin durumunu kontrol et
router.get('/check', async (req, res) => {
  try {
    console.log('Admin kontrolü yapılıyor...');
    
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('Yetkilendirme başlığı eksik veya geçersiz');
      return res.status(401).json({ error: 'Yetkilendirme başlığı gerekli' });
    }
    
    const token = authHeader.split(' ')[1];
    
    // Token ile kullanıcı bilgilerini al
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !userData || !userData.user) {
      console.log('Geçersiz token veya kullanıcı bulunamadı:', userError);
      return res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token' });
    }
    
    console.log('Kullanıcı bulundu:', userData.user.email);
    
    // Veritabanından admin kontrolü
    const { data: adminData, error: adminError } = await supabase
      .from('admins')
      .select('*')
      .eq('user_id', userData.user.id);
    
    // Tablo yoksa veya kullanıcı admin değilse
    if (adminError || !adminData || adminData.length === 0) {
      console.log('Admin tablosunda kullanıcı bulunamadı:', adminError);
      
      // İlk kullanıcıyı admin yap (test için)
      if (adminError && adminError.code === 'PGRST116') {
        console.log('Admin tablosu bulunamadı, tablo oluşturuluyor...');
        
        // Admin tablosunu oluştur
        await supabase.rpc('create_admin_table');
        
        // İlk kullanıcıyı admin yap
        const { error: insertError } = await supabase
          .from('admins')
          .insert({
            user_id: userData.user.id,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          });
        
        if (insertError) {
          console.log('Admin ekleme hatası:', insertError);
          return res.json({ data: { isAdmin: false } });
        }
        
        return res.json({ data: { isAdmin: true } });
      }
      
      return res.json({ data: { isAdmin: false } });
    }
    
    console.log('Kullanıcı admin yetkisine sahip');
    return res.json({ data: { isAdmin: true } });
  } catch (err) {
    console.error('Admin kontrolü hatası:', err);
    res.status(500).json({ error: 'Admin kontrolü sırasında bir hata oluştu' });
  }
});

// Kullanıcıları getir
router.get('/users', authenticateAdmin, async (req, res) => {
  try {
    console.log('Kullanıcılar getiriliyor...');
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const status = req.query.status || 'all';
    
    console.log('Sayfa:', page, 'Limit:', limit, 'Arama:', search, 'Durum:', status);
    
    // Önce profiles tablosundan kullanıcıları getirmeyi dene
    let query = supabase
      .from('profiles')
      .select('id, username, email, created_at');
    
    // Arama filtresi
    if (search) {
      query = query.or(`username.ilike.%${search}%, email.ilike.%${search}%`);
    }
    
    // Toplam sayıyı al
    const { count, error: countError } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      console.error('Toplam kullanıcı sayısı hatası:', countError);
      
      // Eğer profiles tablosunda hata varsa, dummy_profiles tablosunu kontrol et
      const { count: dummyCount, error: dummyCountError } = await supabase
        .from('dummy_profiles')
        .select('*', { count: 'exact', head: true });
      
      if (dummyCountError) {
        console.error('Dummy profil sayısı hatası:', dummyCountError);
        return res.status(500).json({ error: 'Kullanıcı sayısı alınamadı' });
      }
      
      // Dummy profiles tablosundan getir
      const { data: dummyProfiles, error: dummyProfilesError } = await supabase
        .from('dummy_profiles')
        .select('id, username, email, created_at')
        .range(offset, offset + limit - 1)
        .order('created_at', { ascending: false });
      
      if (dummyProfilesError) {
        console.error('Dummy profil getirme hatası:', dummyProfilesError);
        return res.status(500).json({ error: 'Kullanıcılar alınamadı' });
      }
      
      // Dummy kullanıcıları dönüştür
      const dummyUsers = dummyProfiles.map(profile => ({
        id: profile.id,
        username: profile.username,
        email: profile.email,
        created_at: profile.created_at,
        banned: false,
        role: 'user'
      }));
      
      return res.json({
        data: {
          users: dummyUsers,
          total: dummyCount,
          hasMore: offset + dummyUsers.length < dummyCount
        }
      });
    }
    
    console.log('Toplam kullanıcı sayısı:', count);
    
    // Sayfalama
    query = query.range(offset, offset + limit - 1)
                .order('created_at', { ascending: false });
    
    const { data: profilesData, error: profilesError } = await query;
    
    if (profilesError) {
      console.error('Kullanıcı profilleri hatası:', profilesError);
      return res.status(500).json({ error: 'Kullanıcı profilleri alınamadı' });
    }
    
    console.log('Kullanıcı profilleri:', profilesData.length);
    
    // Her kullanıcı için ban durumunu ve rolünü kontrol et
    const users = await Promise.all(profilesData.map(async (profile) => {
      // Ban durumunu kontrol et
      let isBanned = false;
      let banData = null;
      
      try {
        const { data, error } = await supabase
          .from('user_bans')
          .select('*')
          .eq('user_id', profile.id)
          .gte('ban_expires_at', new Date().toISOString())
          .single();
        
        if (!error && data) {
          isBanned = true;
          banData = data;
        }
      } catch (err) {
        console.error('Ban durumu kontrolü hatası:', err);
      }
      
      // Admin rolünü kontrol et
      let isAdmin = false;
      
      try {
        const { data, error } = await supabase
          .from('admins')
          .select('*')
          .eq('user_id', profile.id)
          .single();
        
        if (!error && data) {
          isAdmin = true;
        }
      } catch (err) {
        console.error('Admin kontrolü hatası:', err);
      }
      
      // Moderatör rolünü kontrol et
      let isModerator = false;
      
      try {
        const { data, error } = await supabase
          .from('moderators')
          .select('*')
          .eq('user_id', profile.id)
          .single();
        
        if (!error && data) {
          isModerator = true;
        }
      } catch (err) {
        // Moderatör tablosu yoksa hata yok sayılır
      }
      
      // Kullanıcı rolünü belirle
      let role = 'user';
      if (isAdmin) role = 'admin';
      else if (isModerator) role = 'moderator';
      
      return {
        id: profile.id,
        username: profile.username || 'İsimsiz Kullanıcı',
        email: profile.email || 'email@example.com',
        created_at: profile.created_at,
        banned: isBanned,
        ban_expires_at: isBanned ? banData.ban_expires_at : null,
        ban_reason: isBanned ? banData.reason : null,
        role: role
      };
    }));
    
    console.log('Kullanıcı detayları:', users.length);
    
    // Durum filtresi
    let filteredUsers = users;
    if (status === 'banned') {
      filteredUsers = users.filter(user => user.banned);
    } else if (status === 'active') {
      filteredUsers = users.filter(user => !user.banned);
    }
    
    console.log('Filtrelenmiş kullanıcılar:', filteredUsers.length);
    
    res.json({
      data: {
        users: filteredUsers,
        total: count,
        hasMore: offset + filteredUsers.length < count
      }
    });
  } catch (err) {
    console.error('Kullanıcıları getirme hatası:', err);
    res.status(500).json({ error: 'Kullanıcılar getirilirken bir hata oluştu' });
  }
});

// Kullanıcı detaylarını getir (yardımcı fonksiyon)
async function getUserDetails(userId) {
  try {
    // Profil bilgilerini getir
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('username, email, created_at, updated_at')
      .eq('id', userId)
      .single();
    
    if (profileError) {
      console.error('Profil bilgisi getirme hatası:', profileError);
      return {
        id: userId,
        username: 'Bilinmeyen Kullanıcı',
        email: 'bilinmeyen@email.com',
        created_at: new Date().toISOString(),
        banned: false,
        role: 'user'
      };
    }
    
    // Ban durumunu kontrol et
    let isBanned = false;
    let banData = null;
    
    try {
      const { data, error } = await supabase
        .from('user_bans')
        .select('*')
        .eq('user_id', userId)
        .gte('ban_expires_at', new Date().toISOString())
        .single();
      
      if (!error && data) {
        isBanned = true;
        banData = data;
      }
    } catch (err) {
      console.error('Ban durumu kontrolü hatası:', err);
    }
    
    // Admin rolünü kontrol et
    let isAdmin = false;
    
    try {
      const { data, error } = await supabase
        .from('admins')
        .select('*')
        .eq('user_id', userId)
        .single();
      
      if (!error && data) {
        isAdmin = true;
      }
    } catch (err) {
      console.error('Admin kontrolü hatası:', err);
    }
    
    // Moderatör rolünü kontrol et
    let isModerator = false;
    
    try {
      const { data, error } = await supabase
        .from('moderators')
        .select('*')
        .eq('user_id', userId)
        .single();
      
      if (!error && data) {
        isModerator = true;
      }
    } catch (err) {
      // Moderatör tablosu yoksa hata yok sayılır
    }
    
    // Kullanıcı rolünü belirle
    let role = 'user';
    if (isAdmin) role = 'admin';
    else if (isModerator) role = 'moderator';
    
    return {
      id: userId,
      username: profile.username,
      email: profile.email,
      created_at: profile.created_at,
      updated_at: profile.updated_at,
      banned: isBanned,
      ban_expires_at: isBanned ? banData.ban_expires_at : null,
      ban_reason: isBanned ? banData.reason : null,
      role: role
    };
  } catch (err) {
    console.error('Kullanıcı detayları getirme hatası:', err);
    return {
      id: userId,
      username: 'Bilinmeyen Kullanıcı',
      email: 'bilinmeyen@email.com',
      created_at: new Date().toISOString(),
      banned: false,
      role: 'user'
    };
  }
}

// Kullanıcı detaylarını getir
router.get('/users/:userId', authenticateAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Kullanıcı bilgilerini al
    const { data: userData, error: userError } = await supabase
      .from('profiles')
      .select('*, user_bans(*)')
      .eq('id', userId)
      .single();
    
    if (userError) throw userError;
    
    // Kullanıcı istatistiklerini al
    const { data: statsData, error: statsError } = await supabase
      .rpc('get_user_stats', { user_id: userId });
    
    if (statsError) throw statsError;
    
    // Kullanıcı aktivitelerini al
    const { data: logsData, error: logsError } = await supabase
      .from('user_activity_logs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (logsError) throw logsError;
    
    // Kullanıcı verilerini düzenle
    const isBanned = userData.user_bans && userData.user_bans.length > 0 && 
                    new Date(userData.user_bans[0].ban_expires_at) > new Date();
    
    const user = {
      id: userData.id,
      email: userData.email,
      username: userData.username,
      created_at: userData.created_at,
      banned: isBanned,
      ban_expires_at: isBanned ? userData.user_bans[0].ban_expires_at : null,
      ban_reason: isBanned ? userData.user_bans[0].reason : null
    };
    
    res.json({
      data: {
        user,
        stats: statsData || {},
        logs: logsData || []
      }
    });
  } catch (err) {
    console.error('Kullanıcı detaylarını getirme hatası:', err);
    res.status(500).json({ error: 'Kullanıcı detayları getirilirken bir hata oluştu' });
  }
});

// Dashboard istatistiklerini getir
router.get('/dashboard-stats', authenticateAdmin, async (req, res) => {
  try {
    console.log('Dashboard istatistikleri getiriliyor...');
    
    // Toplam kullanıcı sayısı
    const { count: totalUsers, error: usersError } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true });
    
    if (usersError) {
      console.error('Toplam kullanıcı sayısı hatası:', usersError);
      return res.status(500).json({ error: 'Toplam kullanıcı sayısı alınamadı' });
    }
    
    console.log('Toplam kullanıcı sayısı:', totalUsers);
    
    // Banlı kullanıcı sayısı
    let bannedUsers = 0;
    try {
      const { count, error } = await supabase
        .from('user_bans')
        .select('*', { count: 'exact', head: true })
        .gte('ban_expires_at', new Date().toISOString());
      
      if (!error) {
        bannedUsers = count || 0;
      }
    } catch (err) {
      console.error('Banlı kullanıcı sayısı hatası:', err);
    }
    
    console.log('Banlı kullanıcı sayısı:', bannedUsers);
    
    // Bugünkü görüşme sayısı
    let todayCalls = 0;
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const { count, error } = await supabase
        .from('user_calls')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', today.toISOString());
      
      if (!error) {
        todayCalls = count || 0;
      }
    } catch (err) {
      console.error('Bugünkü görüşme sayısı hatası:', err);
    }
    
    console.log('Bugünkü görüşme sayısı:', todayCalls);
    
    // Aktif kullanıcı sayısı (son 24 saat içinde aktivite gösteren)
    let activeUsers = 0;
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      
      const { data, error } = await supabase
        .from('user_activity_logs')
        .select('user_id')
        .gte('created_at', yesterday.toISOString());
      
      if (!error && data) {
        // Benzersiz kullanıcı ID'lerini say
        const uniqueUserIds = new Set();
        data.forEach(log => uniqueUserIds.add(log.user_id));
        activeUsers = uniqueUserIds.size;
      }
    } catch (err) {
      console.error('Aktif kullanıcı sayısı hatası:', err);
    }
    
    console.log('Aktif kullanıcı sayısı:', activeUsers);
    
    res.json({
      data: {
        totalUsers: totalUsers || 0,
        activeUsers: activeUsers || 0,
        bannedUsers: bannedUsers || 0,
        todayCalls: todayCalls || 0
      }
    });
  } catch (err) {
    console.error('Dashboard istatistikleri getirme hatası:', err);
    res.status(500).json({ error: 'Dashboard istatistikleri getirilirken bir hata oluştu' });
  }
});

// Aktivite günlüğünü getir
router.get('/activity-logs', authenticateAdmin, async (req, res) => {
  try {
    console.log('Aktivite günlüğü getiriliyor...');
    
    const limit = parseInt(req.query.limit) || 100;
    
    // Aktivite günlüğünü getir
    const { data, error } = await supabase
      .from('user_activity_logs')
      .select('id, user_id, action, details, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    
    if (error) {
      console.error('Aktivite günlüğü hatası:', error);
      
      // Tablo yoksa veya başka bir hata varsa boş dizi döndür
      return res.json({ data: { logs: [] } });
    }
    
    console.log('Aktivite günlüğü kayıtları:', data.length);
    
    // Her log için kullanıcı bilgilerini getir
    const logsWithUserDetails = await Promise.all(data.map(async (log) => {
      try {
        // Kullanıcı e-posta adresini getir
        const { data: userData, error: userError } = await supabase
          .from('profiles')
          .select('email')
          .eq('id', log.user_id)
          .single();
        
        return {
          ...log,
          user_email: userError ? 'Bilinmeyen Kullanıcı' : userData.email
        };
      } catch (err) {
        console.error('Kullanıcı bilgisi getirme hatası:', err);
        return {
          ...log,
          user_email: 'Bilinmeyen Kullanıcı'
        };
      }
    }));
    
    console.log('Kullanıcı detaylı aktivite günlüğü:', logsWithUserDetails.length);
    
    res.json({ data: { logs: logsWithUserDetails } });
  } catch (err) {
    console.error('Aktivite günlüğünü getirme hatası:', err);
    res.status(500).json({ error: 'Aktivite günlüğü getirilirken bir hata oluştu' });
  }
});

// Kullanıcıyı banla
router.post('/ban-user', authenticateAdmin, async (req, res) => {
  try {
    const { userId, duration, reason } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'Kullanıcı ID gerekli' });
    }
    
    console.log('Kullanıcı banlanıyor:', userId, 'Süre:', duration, 'Sebep:', reason);
    
    // Ban süresi hesapla
    const banDuration = parseInt(duration) || 24;
    const banExpiresAt = new Date();
    banExpiresAt.setHours(banExpiresAt.getHours() + banDuration);
    
    // Mevcut banı kontrol et
    const { data: existingBan, error: banCheckError } = await supabase
      .from('user_bans')
      .select('*')
      .eq('user_id', userId)
      .single();
    
    if (!banCheckError && existingBan) {
      // Mevcut banı güncelle
      const { data, error } = await supabase
        .from('user_bans')
        .update({
          ban_expires_at: banExpiresAt.toISOString(),
          reason: reason || 'Belirtilmemiş',
          updated_at: new Date().toISOString()
        })
        .eq('id', existingBan.id);
      
      if (error) {
        console.error('Ban güncelleme hatası:', error);
        return res.status(500).json({ error: 'Kullanıcı banı güncellenirken bir hata oluştu' });
      }
      
      console.log('Kullanıcı banı güncellendi:', userId);
    } else {
      // Yeni ban oluştur
      const { data, error } = await supabase
        .from('user_bans')
        .insert({
          user_id: userId,
          ban_expires_at: banExpiresAt.toISOString(),
          reason: reason || 'Belirtilmemiş',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      
      if (error) {
        console.error('Ban oluşturma hatası:', error);
        return res.status(500).json({ error: 'Kullanıcı banlanırken bir hata oluştu' });
      }
      
      console.log('Kullanıcı banlandı:', userId);
    }
    
    // Aktivite günlüğüne ekle
    await supabase
      .from('user_activity_logs')
      .insert({
        user_id: userId,
        action: 'user_banned',
        details: `Kullanıcı ${banDuration} saat banlandı. Sebep: ${reason || 'Belirtilmemiş'}`,
        created_at: new Date().toISOString()
      });
    
    res.json({
      data: {
        success: true,
        message: 'Kullanıcı başarıyla banlandı'
      }
    });
  } catch (err) {
    console.error('Kullanıcı banlama hatası:', err);
    res.status(500).json({ error: 'Kullanıcı banlanırken bir hata oluştu' });
  }
});

// Kullanıcı banını kaldır
router.post('/unban-user', authenticateAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'Kullanıcı ID gerekli' });
    }
    
    console.log('Kullanıcı banı kaldırılıyor:', userId);
    
    // Mevcut banı kontrol et
    const { data: existingBan, error: banCheckError } = await supabase
      .from('user_bans')
      .select('*')
      .eq('user_id', userId)
      .single();
    
    if (!banCheckError && existingBan) {
      // Banı kaldır (süresi geçmiş olarak işaretle)
      const { data, error } = await supabase
        .from('user_bans')
        .update({
          ban_expires_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', existingBan.id);
      
      if (error) {
        console.error('Ban kaldırma hatası:', error);
        return res.status(500).json({ error: 'Kullanıcı banı kaldırılırken bir hata oluştu' });
      }
      
      console.log('Kullanıcı banı kaldırıldı:', userId);
      
      // Aktivite günlüğüne ekle
      await supabase
        .from('user_activity_logs')
        .insert({
          user_id: userId,
          action: 'user_unbanned',
          details: 'Kullanıcı banı kaldırıldı',
          created_at: new Date().toISOString()
        });
      
      res.json({
        data: {
          success: true,
          message: 'Kullanıcı banı başarıyla kaldırıldı'
        }
      });
    } else {
      console.log('Kullanıcı zaten banlı değil:', userId);
      res.json({
        data: {
          success: true,
          message: 'Kullanıcı zaten banlı değil'
        }
      });
    }
  } catch (err) {
    console.error('Kullanıcı banı kaldırma hatası:', err);
    res.status(500).json({ error: 'Kullanıcı banı kaldırılırken bir hata oluştu' });
  }
});

// Kullanıcı rolünü değiştir
router.post('/change-role', authenticateAdmin, async (req, res) => {
  try {
    const { userId, role } = req.body;
    
    if (!userId || !role) {
      return res.status(400).json({ error: 'Kullanıcı ID ve rol gerekli' });
    }
    
    console.log('Kullanıcı rolü değiştiriliyor:', userId, 'Yeni rol:', role);
    
    // Önce tüm rolleri kaldır
    
    // Admin rolünü kaldır
    try {
      await supabase
        .from('admins')
        .delete()
        .eq('user_id', userId);
    } catch (err) {
      console.error('Admin rolü kaldırma hatası:', err);
    }
    
    // Moderatör rolünü kaldır
    try {
      await supabase
        .from('moderators')
        .delete()
        .eq('user_id', userId);
    } catch (err) {
      console.error('Moderatör rolü kaldırma hatası:', err);
    }
    
    // Yeni rolü ekle
    if (role === 'admin') {
      const { data, error } = await supabase
        .from('admins')
        .insert({
          user_id: userId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      
      if (error) {
        console.error('Admin rolü ekleme hatası:', error);
        return res.status(500).json({ error: 'Admin rolü eklenirken bir hata oluştu' });
      }
      
      console.log('Kullanıcı admin yapıldı:', userId);
    } else if (role === 'moderator') {
      const { data, error } = await supabase
        .from('moderators')
        .insert({
          user_id: userId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      
      if (error) {
        console.error('Moderatör rolü ekleme hatası:', error);
        return res.status(500).json({ error: 'Moderatör rolü eklenirken bir hata oluştu' });
      }
      
      console.log('Kullanıcı moderatör yapıldı:', userId);
    } else {
      console.log('Kullanıcı normal kullanıcı yapıldı:', userId);
    }
    
    // Aktivite günlüğüne ekle
    await supabase
      .from('user_activity_logs')
      .insert({
        user_id: userId,
        action: 'role_changed',
        details: `Kullanıcı rolü ${role} olarak değiştirildi`,
        created_at: new Date().toISOString()
      });
    
    res.json({
      data: {
        success: true,
        message: 'Kullanıcı rolü başarıyla değiştirildi'
      }
    });
  } catch (err) {
    console.error('Kullanıcı rolü değiştirme hatası:', err);
    res.status(500).json({ error: 'Kullanıcı rolü değiştirilirken bir hata oluştu' });
  }
});

// Kullanıcı istatistiklerini getir
router.get('/user-stats/:userId', authenticateAdmin, async (req, res) => {
  try {
    const userId = req.params.userId;
    console.log('Kullanıcı istatistikleri getiriliyor:', userId);
    
    // Kullanıcı çağrı istatistiklerini getir
    const { data: callData, error: callError } = await supabase
      .from('user_calls')
      .select('duration, created_at')
      .eq('user_id', userId);
    
    if (callError) {
      console.error('Kullanıcı çağrı istatistikleri hatası:', callError);
      return res.status(500).json({ error: 'Kullanıcı çağrı istatistikleri alınamadı' });
    }
    
    // İstatistikleri hesapla
    let callCount = 0;
    let totalDuration = 0;
    let lastCall = null;
    
    if (callData && callData.length > 0) {
      callCount = callData.length;
      
      callData.forEach(call => {
        totalDuration += call.duration || 0;
        
        // Son çağrı tarihini güncelle
        if (!lastCall || new Date(call.created_at) > new Date(lastCall)) {
          lastCall = call.created_at;
        }
      });
    }
    
    res.json({
      data: {
        callCount,
        totalDuration,
        lastCall
      }
    });
  } catch (err) {
    console.error('Kullanıcı istatistikleri getirme hatası:', err);
    res.status(500).json({ error: 'Kullanıcı istatistikleri getirilirken bir hata oluştu' });
  }
});

// Kullanıcı aktivite günlüğünü getir
router.get('/user-logs/:userId', authenticateAdmin, async (req, res) => {
  try {
    const userId = req.params.userId;
    console.log('Kullanıcı aktivite günlüğü getiriliyor:', userId);
    
    // Kullanıcı aktivite günlüğünü getir
    const { data, error } = await supabase
      .from('user_activity_logs')
      .select('id, action, details, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);
    
    if (error) {
      console.error('Kullanıcı aktivite günlüğü hatası:', error);
      return res.status(500).json({ error: 'Kullanıcı aktivite günlüğü alınamadı' });
    }
    
    res.json({
      data
    });
  } catch (err) {
    console.error('Kullanıcı aktivite günlüğü getirme hatası:', err);
    res.status(500).json({ error: 'Kullanıcı aktivite günlüğü getirilirken bir hata oluştu' });
  }
});

// En aktif kullanıcıları getir
router.get('/top-active-users', authenticateAdmin, async (req, res) => {
  try {
    // Kullanıcı çağrı istatistiklerini getir
    let userStats = [];
    
    try {
      // user_calls tablosundan istatistikleri getir
      const { data: callData, error: callError } = await supabase
        .from('user_calls')
        .select('user_id, duration, created_at');
      
      if (!callError && callData) {
        // Kullanıcı bazında istatistikleri hesapla
        const userCallStats = {};
        
        callData.forEach(call => {
          if (!userCallStats[call.user_id]) {
            userCallStats[call.user_id] = {
              userId: call.user_id,
              callCount: 0,
              totalDuration: 0,
              lastCall: null
            };
          }
          
          userCallStats[call.user_id].callCount++;
          userCallStats[call.user_id].totalDuration += call.duration || 0;
          
          // Son çağrı tarihini güncelle
          if (!userCallStats[call.user_id].lastCall || new Date(call.created_at) > new Date(userCallStats[call.user_id].lastCall)) {
            userCallStats[call.user_id].lastCall = call.created_at;
          }
        });
        
        // Objeyi diziye çevir
        userStats = Object.values(userCallStats);
      }
    } catch (err) {
      console.error('Kullanıcı çağrı istatistikleri getirme hatası:', err);
      // Hata durumunda boş dizi kullan
      userStats = [];
    }
    
    // Toplam süreye göre sırala
    userStats.sort((a, b) => b.totalDuration - a.totalDuration);
    
    // İlk 10 kullanıcıyı al
    const topUsers = userStats.slice(0, 10);
    
    // Kullanıcı detaylarını getir
    const usersWithDetails = await Promise.all(topUsers.map(async (stat) => {
      try {
        // Kullanıcı profilini getir
        const { data: profileData, error: profileError } = await supabase
          .from('profiles')
          .select('username, email')
          .eq('id', stat.userId)
          .single();
        
        if (profileError) throw profileError;
        
        return {
          id: stat.userId,
          username: profileData.username,
          email: profileData.email,
          callCount: stat.callCount,
          totalDuration: stat.totalDuration,
          lastCall: stat.lastCall
        };
      } catch (err) {
        console.error('Kullanıcı detayları getirme hatası:', err);
        return {
          id: stat.userId,
          username: 'Bilinmeyen Kullanıcı',
          email: 'bilinmeyen@email.com',
          callCount: stat.callCount,
          totalDuration: stat.totalDuration,
          lastCall: stat.lastCall
        };
      }
    }));
    
    res.json({ data: { users: usersWithDetails } });
  } catch (err) {
    console.error('En aktif kullanıcıları getirme hatası:', err);
    res.status(500).json({ error: 'En aktif kullanıcılar getirilirken bir hata oluştu' });
  }
});

module.exports = router; 