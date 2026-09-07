@echo off
python pipeline\auto_translate_cn.py ^
  --backend baidu ^
  --baidu-appid 20260731002656265 ^
  --baidu-key OwI9Z0AzTV9ef3qONL9v ^
  --continue-on-error
pause
