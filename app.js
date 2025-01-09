const express = require('express');
const ejs = require('ejs');
const path = require('path');

const app = express();

// Koyeb에서 제공하는 PORT 환경 변수를 사용 (기본값: 3000)
const PORT = process.env.PORT || 3000;

// EJS 설정
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 정적 파일 경로 설정
app.use('/public', express.static(path.join(__dirname, 'public')));

// Body-parser 대체 (express 내장 기능 사용)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 라우터 설정
const mainRouter = require('./router/mainRouter');
app.use('/', mainRouter);

// 서버 실행
app.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});
