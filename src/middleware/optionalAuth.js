const jwt = require('jsonwebtoken');
const supabase = require('./../lib/supabase');

// Мягкая авторизация: токен разбираем, если он есть, но без него не отказываем.
// Нужна экранам, которые должны открываться и гостю — например, Колесо Фортуны:
// человек крутит до регистрации, иначе акция не работает как приманка.
//
// ⚠️ Отличие от auth: битый или протухший токен здесь НЕ ошибка, а «гость».
// Роут обязан сам решать, что можно без аккаунта, и ничего личного гостю не
// отдавать — req.userId у него просто undefined.
async function optionalAuth(req, _res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next();

  let decoded;
  try {
    decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
  } catch {
    return next(); // гость с просроченным токеном — всё ещё гость
  }

  try {
    const { data: user } = await supabase
      .from('users')
      .select('id, is_blocked, deleted_at')
      .eq('id', decoded.userId)
      .single();
    // Удалённого или заблокированного дальше пускаем гостем, а не с его id:
    // так он не увидит чужих данных и не получит лишнюю попытку на аккаунт.
    if (!user || user.deleted_at || user.is_blocked) return next();
  } catch (err) {
    console.error('optionalAuth db check error:', err);
    return next();
  }

  req.userId = decoded.userId;
  req.phone = decoded.phone;
  next();
}

module.exports = optionalAuth;
