const express = require('express');
const router = express.Router();
const { getSupabase } = require('../config/supabase');

// Tüm konuları getir
router.get('/', async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('topics')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) {
      return res.status(500).json({ error: 'Konular getirilirken hata oluştu' });
    }
    
    return res.json({ topics: data });
  } catch (err) {
    console.error('Konuları getirme hatası:', err);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Yeni konu oluştur
router.post('/', async (req, res) => {
  const { title, content } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Yetkilendirme gerekli' });
  }
  
  if (!title || !content) {
    return res.status(400).json({ error: 'Başlık ve içerik gerekli' });
  }
  
  try {
    const supabase = getSupabase();
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Geçersiz token' });
    }
    
    // Yeni konu oluştur
    const { data, error } = await supabase
      .from('topics')
      .insert({
        title,
        content,
        user_id: user.id,
        created_at: new Date()
      })
      .select()
      .single();
    
    if (error) {
      return res.status(500).json({ error: 'Konu oluşturulurken hata oluştu' });
    }
    
    return res.status(201).json({ topic: data });
  } catch (err) {
    console.error('Konu oluşturma hatası:', err);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

module.exports = router; 