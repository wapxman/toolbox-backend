const jwt = require('jsonwebtoken');

// Middleware: проверяет JWT-токен в заголовке Authorization
function auth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Необходима авторизация' });
  }

  const token = header.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    req.phone = decoded.phone;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Невалидный токен' });
  }
}

module.exports = auth;
