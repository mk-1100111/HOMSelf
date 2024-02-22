const express = require('express')
const router = express.Router();

router.get("/", function(req,res){
    res.render('index', {title:'HOMSelf'})
})

router.get("/main", function(req,res){
    res.render('main');
})

router.get("/manager_list", function(req,res){
    res.render('manager_list');
})

router.get("/material_list", function(req,res){
    res.render('material_list');
})

module.exports = router