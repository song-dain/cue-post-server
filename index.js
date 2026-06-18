require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cardRoutes = require('./routes/cardRoutes'); 

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

// 카드 관련 API 라우터 매핑
app.use('/api/cards', cardRoutes);

app.listen(PORT, () => {
  console.log(`🚀 서버가 포트 ${PORT}에서 작동 중입니다!`);
});