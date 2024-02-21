# -*- coding: utf-8 -*-

image_list = [
    "고지훈", "구자원", "구재화", "권석천", "권성영",
    "권필중", "김대교", "김대선", "김동민", "김승준",
    "김영광", "김유빈", "김해원", "김홍렬", "민천의",
    "방기영", "백광융", "서동국", "서동재", "신동경",
    "안종훈", "유정모", "육강심", "윤학용", "이상운",
    "이상칠", "이성주", "이인욱", "이창규", "이흥준",
    "임규열", "임정우", "장민수", "장현숙", "정대성",
    "정윤정", "정준권", "조준희", "최승철", "최승현",
    "추우영", "한신희"
]

html_code = '''
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>이미지 목록</title>
</head>
<body>
<div class="row">
'''

for image_name in image_list:
    # 파일명에서 확장자 제거
    image_name_without_extension = image_name.split('.')[0]
    html_code += f'''
    <div class="col">
        <div class="card">
            <img src="./static/img/manager_list/{image_name}" class="card-img-top" alt="...">
            <div class="card-body">
                <h5 class="card-title">{image_name_without_extension}</h5>
            </div>
        </div>
    </div>
    '''

html_code += '''
</div>
</body>
</html>
'''

with open("이미지_목록.html", "w", encoding="utf-8") as file:
    file.write(html_code)

print("HTML 파일이 생성되었습니다.")
