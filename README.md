# MHD Prešov – živé polohy autobusov

Webová aplikácia so živými polohami autobusov MHD Prešov (linky 1, 13, 21, 28, 37, N2) na mape OpenStreetMap.

## Funkcie
- polohy autobusov z mhdpo.sk (WebSocket), meškanie v m:ss, blikajúca ikonka pri neaktuálnom GPS
- trasa a zastávky z GTFS, oba smery vedľa seba, šípky smeru jazdy
- klik na zastávku → odchody pre daný smer, vybraná zastávka zvýraznená
- prepínač liniek (URL `#13`, `#21`, …)
- voliteľne HTTPS (`SSL_CERT`, `SSL_KEY`)

## Spustenie (Docker)
```bash
docker run -d --name mhdpo --restart unless-stopped -p 3002:3000 smarttechlab/mhdpo:latest
```

S HTTPS:
```bash
docker run -d --name mhdpo --restart unless-stopped -p 3002:3000 \
  -v /cesta/certs:/certs:ro \
  -e SSL_CERT=/certs/fullchain.pem -e SSL_KEY=/certs/privkey.pem \
  smarttechlab/mhdpo:latest
```

## Vývoj
```bash
npm install
node server.js   # http://localhost:3000
```
