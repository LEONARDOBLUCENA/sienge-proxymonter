# sienge-proxymonter

Proxy server entre o Monter Adm | BI (GitHub Pages) e a API REST do Sienge.

## Por que existe
- O Sienge exige usuário/senha de integração (Basic Auth) — isso não pode ficar exposto no HTML público do GitHub Pages.
- O Sienge não libera CORS para chamadas diretas do navegador.

Este servidor resolve os dois problemas: guarda as credenciais como variável de ambiente no Railway e libera CORS só para o domínio do BI.

## Passo a passo para colocar no ar

### 1. Subir este código para o repositório
No terminal, dentro desta pasta:
```bash
git init
git add .
git commit -m "sienge-proxymonter inicial"
git branch -M main
git remote add origin https://github.com/LEONARDOBLUCENA/sienge-proxymonter.git
git push -u origin main
```

### 2. Conectar o Railway ao repositório
No painel do Railway → New Project → Deploy from GitHub repo → selecione `sienge-proxymonter`.
O Railway detecta automaticamente que é um projeto Node.js (por causa do `package.json`) e roda `npm install` + `npm start`.

### 3. Configurar as variáveis de ambiente
No Railway: **Settings → Variables**, adicione:

| Variável | Valor |
|---|---|
| `SIENGE_SUBDOMINIO` | o subdomínio da sua conta Sienge (ex: se a URL é `https://api.sienge.com.br/monter/...`, o valor é `monter`) |
| `SIENGE_USUARIO` | usuário de integração cadastrado no Sienge |
| `SIENGE_SENHA` | senha desse usuário |
| `ALLOWED_ORIGIN` | `https://leonardoblucena.github.io` |

**Onde conseguir usuário/senha de integração:** dentro do Sienge, em Configurações → API / Integrações → Usuários de API. Se não existir um usuário de integração ainda, precisa ser criado lá (não é o mesmo login do sistema).

### 4. Testar se subiu certo
Depois do deploy, o Railway te dá uma URL tipo `https://sienge-proxymonter-production.up.railway.app`. Acesse:
- `/` → deve responder `{"servico":"sienge-proxymonter","status":"online","credenciaisConfiguradas":true}`
- `/api/test` → tenta autenticar de verdade no Sienge e mostra o resultado (esse é o teste que confirma se usuário/senha estão certos)

### 5. Chamar a API do Sienge a partir do BI
Qualquer endpoint do Sienge pode ser chamado assim, trocando `income` pelo endpoint desejado:
```js
fetch('https://sienge-proxymonter-production.up.railway.app/api/sienge/income?limit=200')
  .then(r => r.json())
  .then(dados => console.log(dados));
```
O proxy repassa a query string e a resposta exatamente como o Sienge devolve — só adiciona a autenticação no meio do caminho.

## Próximos passos
Depois que `/api/test` confirmar que a conexão funciona, o próximo passo é decidir **quais endpoints do Sienge** o BI vai consumir (contas a pagar, contas a receber, orçamento de obra, etc.) e mapear os dados retornados para o formato que o `DATA.csv`/`DATA.orcamento` do Monter Adm BI espera.
