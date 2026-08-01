# Настройка Nginx Proxy Manager

1. Hosts → Proxy Hosts → Add Proxy Host.
2. Domain Names: `tree.example.ru`.
3. Scheme: `http`.
4. Forward Hostname/IP: локальный IP Raspberry Pi.
5. Forward Port: `8090`.
6. Включить Websockets Support и Block Common Exploits.
7. На вкладке SSL запросить Let's Encrypt, включить Force SSL и HTTP/2.

В Advanced можно добавить:

```nginx
client_max_body_size 12m;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```
