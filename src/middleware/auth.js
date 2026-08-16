const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabase');

// Middleware: проверяет JWT-токен в заголовке Authorization.
// Дополнительно сверяется с БД: удалённый (deleted_at) или заблокированный
// (is_blocked) пользователь не должен ходить по API со старым 30-дневным токеном.
async function auth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Необходима авторизация' });
  }

  const token = header.split(' ')[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Невалидный токен' });
  }

  try {
    const { data: user } = await supabase
      .from('users')
      .select('id, is_blocked, deleted_at')
      .eq('id', decoded.userId)
      .single();

    if (!user || user.deleted_at) {
      return res.status(401).json({ error: 'Аккаунт удалён, войдите заново' });
    }
    if (user.is_blocked) {
      return res.status(403).json({ error: 'Аккаунт заблокирован' });
    }
  } catch (err) {
    // При сбое БД не роняем запрос целиком — дальше роут сам упадёт с понятной ошибкой
    console.error('auth middleware db check error:', err);
  }

  req.userId = decoded.userId;
  req.phone = decoded.phone;
  next();
}

module.exports = auth;
