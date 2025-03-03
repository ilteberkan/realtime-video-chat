const express = require('express');
const router = express.Router();
const { getSupabase } = require('../config/supabase');

// Kullanıcı oturum bilgilerini doğrula
router.post('/verify', async (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({ error: 'Token gerekli' });
  }
  
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.getUser(token);
    
    if (error) {
      return res.status(401).json({ error: 'Geçersiz token' });
    }
    
    return res.json({ user: data.user });
  } catch (err) {
    console.error('Token doğrulama hatası:', err);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

module.exports = router; 