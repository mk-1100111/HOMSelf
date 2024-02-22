
const express = require('express');
// const helmet = require('helmet');

const app = express();
const ejs = require('ejs')

app.set('view engine', 'ejs');
app.set('views', './views');
app.use('/public/', express.static(__dirname + '/public'));

// app.use((req, res, next) => {
//     res.setHeader('Content-Security-Policy', "script-src 'self' https://ajax.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net 'unsafe-inline'");
//     next();
// });

// app.use(helmet());
app.use(express.json());
app.use(express.urlencoded());


const mainRouter = require('./router/mainRouter')
app.use('/', mainRouter)


app.listen(3000, function(req,res){
    console.log('서버 실행')
})

