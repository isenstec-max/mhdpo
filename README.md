# MHD Prešov – živé polohy autobusov

Webová aplikácia so živými polohami autobusov MHD Prešov (všetky linky – zoznam z GTFS) na mape OpenStreetMap.

## Funkcie
- polohy autobusov z mhdpo.sk (WebSocket), meškanie v m:ss, blikajúca ikonka pri neaktuálnom GPS
- trasa a zastávky z GTFS, oba smery vedľa seba, šípky smeru jazdy
- oblúbené linky: hviezdička ☆ pri názve linky, zoznam pod prepínačom (uložené v prehliadači)
- prihlásenie menom a heslom – oblúbené sa uložia na server (súbor `/app/data/users.json`, heslá ako scrypt hash)
- inštalovateľná appka (PWA): v Chrome na Androide „Pridať na plochu“ / „Inštalovať aplikáciu“
- klik na zastávku → odchody pre daný smer, vybraná zastávka zvýraznená
- prepínač všetkých liniek MHD Prešov (URL `#13`, `#44`, …)
- voliteľne HTTPS (`SSL_CERT`, `SSL_KEY`)

## Spustenie (Docker)
```bash
docker run -d --name mhdpo --restart unless-stopped -p 3002:3000 -v mhdpo-data:/app/data smarttechlab/mhdpo:latest
```

S HTTPS:
```bash
docker run -d --name mhdpo --restart unless-stopped -p 3002:3000 -v mhdpo-data:/app/data \
  -v /cesta/certs:/certs:ro \
  -e SSL_CERT=/certs/fullchain.pem -e SSL_KEY=/certs/privkey.pem \
  smarttechlab/mhdpo:latest
```

## Vývoj
```bash
npm install
node server.js   # http://localhost:3000
```
