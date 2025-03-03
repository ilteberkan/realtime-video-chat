const express = require('express');
const router = express.Router();
const { getSupabase } = require('../config/supabase');
const { createClient } = require('@supabase/supabase-js');
const { authenticate } = require('../middleware/authMiddleware');

// Supabase istemcisini oluştur
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Kullanıcı profili getir
router.get('/profile', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Yetkilendirme gerekli' });
  }
  
  try {
    const supabase = getSupabase();
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Geçersiz token' });
    }
    
    // Kullanıcı profilini getir
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();
    
    if (error) {
      return res.status(404).json({ error: 'Profil bulunamadı' });
    }
    
    return res.json({ profile: data });
  } catch (err) {
    console.error('Profil getirme hatası:', err);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Kullanıcı beğenmeme
router.post('/dislike', authenticate, async (req, res) => {
  try {
    const { roomId } = req.body;
    const userId = req.user.id;
    
    if (!roomId) {
      return res.status(400).json({ error: 'Oda ID gerekli' });
    }
    
    // Odadaki diğer kullanıcıyı bul
    const { data: roomData, error: roomError } = await supabase
      .from('calls')
      .select('user1_id, user2_id')
      .eq('room_id', roomId)
      .single();
    
    if (roomError) {
      return res.status(404).json({ error: 'Oda bulunamadı' });
    }
    
    // Beğenilmeyen kullanıcıyı belirle
    const dislikedUserId = roomData.user1_id === userId ? roomData.user2_id : roomData.user1_id;
    
    // Beğenmeme kaydını ekle
    const { data, error } = await supabase
      .from('user_dislikes')
      .insert({
        user_id: userId,
        disliked_user_id: dislikedUserId,
        created_at: new Date().toISOString()
      });
    
    if (error) {
      throw error;
    }
    
    // Aktivite günlüğüne ekle
    await supabase
      .from('user_activity_logs')
      .insert({
        user_id: userId,
        action: 'user_disliked',
        details: `Kullanıcı beğenilmedi: ${dislikedUserId}`,
        created_at: new Date().toISOString()
      });
    
    res.json({ data: { success: true } });
  } catch (err) {
    console.error('Beğenmeme hatası:', err);
    res.status(500).json({ error: 'Beğenmeme işlemi sırasında bir hata oluştu' });
  }
});

module.exports = router; 