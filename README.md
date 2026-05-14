# BetBoom Premios

Projeto pronto para deploy no Railway usando Node.js e Express.

## Deploy no Railway

1. Crie um novo projeto no Railway a partir deste repositorio do GitHub.
2. Em `Variables`, cadastre as variaveis de ambiente abaixo.
3. O Railway deve usar automaticamente:
   - Build: Nixpacks
   - Start command: `npm start`
   - Healthcheck: `/health`

## Variaveis obrigatorias

```env
PAYMENT_API_URL=https://api.ironpayapp.com.br/api/public/v1
PAYMENT_API_KEY=
PAYMENT_PIX_ENDPOINT=/transactions
IRONPAY_OFFER_HASH=
IRONPAY_PRODUCT_HASH=
IRONPAY_POSTBACK_URL=
IRONPAY_EXPIRE_IN_DAYS=1
```

Nao cadastre `PORT` no Railway. A propria plataforma injeta essa variavel.

## Teste local

```bash
npm install
npm start
```

Depois acesse `http://localhost:3000`.
