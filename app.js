const express = require('express');
const ejs = require('ejs');
const path = require('path');

const app = express();

// Railway에서 제공하는 PORT 사용 (로컬 실행 시 기본 3000)
const PORT = process.env.PORT || 3000;

// EJS 설정
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 정적 파일 제공
app.use('/public', express.static(path.join(__dirname, 'public')));

// Body parser (Express 내장)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 메인 라우터
const mainRouter = require('./router/mainRouter');
app.use('/', mainRouter);

// 서버 시작
app.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});
