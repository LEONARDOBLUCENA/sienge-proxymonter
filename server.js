// sienge-proxymonter
// Proxy server para a API REST do Sienge, usado pelo Monter Adm | BI (GitHub Pages).
//
// Por que esse proxy existe:
// 1. A API do Sienge exige Basic Auth com usuário/senha de integração — isso NUNCA pode
//    ficar exposto no HTML do GitHub Pages (qualquer visitante veria no código-fonte).
// 2. A API do Sienge não libera CORS para chamadas diretas do navegador.
// Esse servidor resolve os dois problemas: guarda as credenciais em variáveis de
// ambiente (só existem aqui no Railway) e libera CORS para o domínio do BI.

const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());

// ---------- Configuração ----------
const {
  SIENGE_SUBDOMINIO,   // ex: "monter" -> https://api.sienge.com.br/monter/public/api/v1
  SIENGE_USUARIO,      // usuário de integração cadastrado no Sienge
  SIENGE_SENHA,        // senha do usuário de integração
  ALLOWED_ORIGIN,       // ex: https://leonardoblucena.github.io (separar por vírgula se mais de um)
  PORT
} = process.env;

const SIENGE_BASE_URL = SIENGE_SUBDOMINIO
  ? `https://api.sienge.com.br/${SIENGE_SUBDOMINIO}/public/api/v1`
  : null;

const originsPermitidos = (ALLOWED_ORIGIN || '*')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: originsPermitidos.includes('*') ? true : originsPermitidos,
  methods: ['GET', 'POST', 'OPTIONS'],
}));

function credenciaisOk() {
  return Boolean(SIENGE_SUBDOMINIO && SIENGE_USUARIO && SIENGE_SENHA);
}

function authHeader() {
  const token = Buffer.from(`${SIENGE_USUARIO}:${SIENGE_SENHA}`).toString('base64');
  return `Basic ${token}`;
}

// ---------- Rotas de diagnóstico ----------

// Raiz - confirma que o serviço subiu
app.get('/', (req, res) => {
  res.json({
    servico: 'sienge-proxymonter',
    status: 'online',
    credenciaisConfiguradas: credenciaisOk(),
  });
});

// Healthcheck simples (Railway usa isso para saber se o deploy está saudável)
app.get('/health', (req, res) => res.status(200).send('ok'));

// Testa se as credenciais do Sienge estão funcionando de fato
app.get('/api/test', async (req, res) => {
  if (!credenciaisOk()) {
    return res.status(500).json({
      erro: 'Variáveis de ambiente do Sienge não configuradas.',
      faltando: {
        SIENGE_SUBDOMINIO: !SIENGE_SUBDOMINIO,
        SIENGE_USUARIO: !SIENGE_USUARIO,
        SIENGE_SENHA: !SIENGE_SENHA,
      },
    });
  }
  try {
    // /cost-centers é um endpoint leve, bom para só confirmar que a autenticação funciona
    const r = await fetch(`${SIENGE_BASE_URL}/cost-centers?limit=1`, {
      headers: { Authorization: authHeader() },
    });
    const texto = await r.text();
    res.status(r.status).json({
      status: r.status,
      ok: r.ok,
      resposta: safeJson(texto),
    });
  } catch (err) {
    res.status(502).json({ erro: 'Falha ao conectar no Sienge', detalhe: String(err) });
  }
});

// ---------- Contas a Pagar completo (títulos + parcelas, pago x a pagar) ----------
// Isso resolve o trabalho manual de abrir /bills e depois cada /bills/{id}/installments
// um por um. Aqui o servidor já faz tudo isso e devolve pronto, uma linha por parcela.
//
// Uso: /api/sienge/contas-pagar-completo?startDate=2026-01-01&endDate=2026-01-31
app.get('/api/sienge/contas-pagar-completo', async (req, res) => {
  if (!credenciaisOk()) {
    return res.status(500).json({ erro: 'Variáveis de ambiente do Sienge não configuradas no Railway.' });
  }
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ erro: 'Informe startDate e endDate na URL, formato AAAA-MM-DD. Ex: ?startDate=2026-01-01&endDate=2026-01-31' });
  }

  try {
    // 1) Busca todos os títulos (bills) do período, paginando (a API devolve no máximo 100/200 por vez)
    const limitePorPagina = 100;
    let offset = 0;
    let bills = [];
    while (true) {
      const url = `${SIENGE_BASE_URL}/bills?startDate=${startDate}&endDate=${endDate}&selectionType=D&limit=${limitePorPagina}&offset=${offset}`;
      const r = await fetch(url, { headers: { Authorization: authHeader() } });
      if (!r.ok) {
        const texto = await r.text();
        return res.status(r.status).json({ erro: 'Falha ao buscar títulos (bills)', resposta: safeJson(texto) });
      }
      const dados = await r.json();
      const pagina = dados.results || [];
      bills = bills.concat(pagina);
      const total = (dados.resultSetMetadata && dados.resultSetMetadata.count) || 0;
      offset += limitePorPagina;
      if (pagina.length === 0 || offset >= total) break;
    }

    // 2) Para cada título, busca as parcelas (installments) — em lotes, para não sobrecarregar a API do Sienge
    const TAMANHO_LOTE = 5;
    const comInstallments = [];
    for (let i = 0; i < bills.length; i += TAMANHO_LOTE) {
      const lote = bills.slice(i, i + TAMANHO_LOTE);
      const respostasLote = await Promise.all(lote.map(async (bill) => {
        try {
          const rInst = await fetch(`${SIENGE_BASE_URL}/bills/${bill.id}/installments`, {
            headers: { Authorization: authHeader() },
          });
          if (!rInst.ok) return { bill, installments: [], erroParcelas: `status ${rInst.status}` };
          const dadosInst = await rInst.json();
          const installments = Array.isArray(dadosInst) ? dadosInst : (dadosInst.results || []);
          return { bill, installments };
        } catch (e) {
          return { bill, installments: [], erroParcelas: String(e) };
        }
      }));
      comInstallments.push(...respostasLote);
    }

    // 3) Achata tudo em uma lista simples: uma linha por parcela, já classificada
    const parcelas = [];
    comInstallments.forEach(({ bill, installments, erroParcelas }) => {
      if (!installments.length) {
        parcelas.push({
          billId: bill.id,
          documentNumber: bill.documentNumber,
          documentIdentificationId: bill.documentIdentificationId,
          creditorId: bill.creditorId,
          debtorId: bill.debtorId,
          issueDate: bill.issueDate,
          totalInvoiceAmount: bill.totalInvoiceAmount,
          erroParcelas: erroParcelas || 'Sem parcelas retornadas',
        });
        return;
      }
      installments.forEach((inst) => {
        // Campos de saldo/valor variam um pouco conforme a API do Sienge — mantemos o "raw"
        // para você conferir os nomes exatos e eu ajustar aqui se precisar.
        const saldo = inst.balanceAmount ?? inst.currentBalance ?? null;
        const pago = saldo !== null ? saldo <= 0 : (inst.status === 'paid' || inst.status === 2 || inst.status === 3);
        parcelas.push({
          billId: bill.id,
          documentNumber: bill.documentNumber,
          documentIdentificationId: bill.documentIdentificationId,
          creditorId: bill.creditorId,
          debtorId: bill.debtorId,
          issueDate: bill.issueDate,
          installmentId: inst.id ?? inst.installmentId,
          dueDate: inst.dueDate,
          amount: inst.amount ?? inst.originalValue ?? null,
          balance: saldo,
          pago,
          raw: inst,
        });
      });
    });

    res.json({
      status: 200,
      ok: true,
      periodo: { startDate, endDate },
      totalTitulos: bills.length,
      totalParcelas: parcelas.length,
      resultados: parcelas,
    });
  } catch (err) {
    res.status(502).json({ erro: 'Falha ao montar contas a pagar completo', detalhe: String(err) });
  }
});

// ---------- Contas a Receber completo (clientes + parcelas, recebido x a receber) ----------
// Busca todos os clientes e, para cada um, consulta o saldo devedor (que já traz as
// parcelas pagas e as parcelas em aberto). Devolve tudo achatado, uma linha por parcela.
//
// Uso: /api/sienge/contas-receber-completo
app.get('/api/sienge/contas-receber-completo', async (req, res) => {
  if (!credenciaisOk()) {
    return res.status(500).json({ erro: 'Variáveis de ambiente do Sienge não configuradas no Railway.' });
  }

  try {
    // 1) Busca todos os clientes, paginando
    const limitePorPagina = 100;
    let offset = 0;
    let clientes = [];
    while (true) {
      const url = `${SIENGE_BASE_URL}/customers?limit=${limitePorPagina}&offset=${offset}`;
      const r = await fetch(url, { headers: { Authorization: authHeader() } });
      if (!r.ok) {
        const texto = await r.text();
        return res.status(r.status).json({ erro: 'Falha ao buscar clientes (customers)', resposta: safeJson(texto) });
      }
      const dados = await r.json();
      const pagina = dados.results || [];
      clientes = clientes.concat(pagina);
      const total = (dados.resultSetMetadata && dados.resultSetMetadata.count) || 0;
      offset += limitePorPagina;
      if (pagina.length === 0 || offset >= total) break;
    }

    // Só interessam os clientes que têm CPF ou CNPJ (current-debit-balance exige um dos dois)
    const clientesComDocumento = clientes.filter(c => c.cpf || c.cnpj);

    // 2) Para cada cliente, busca o saldo devedor presente (em lotes, para não sobrecarregar o Sienge)
    const TAMANHO_LOTE = 5;
    const comSaldo = [];
    for (let i = 0; i < clientesComDocumento.length; i += TAMANHO_LOTE) {
      const lote = clientesComDocumento.slice(i, i + TAMANHO_LOTE);
      const respostasLote = await Promise.all(lote.map(async (cliente) => {
        const paramDoc = cliente.cnpj ? `cnpj=${cliente.cnpj}` : `cpf=${cliente.cpf}`;
        try {
          const rSaldo = await fetch(`${SIENGE_BASE_URL}/current-debit-balance?${paramDoc}`, {
            headers: { Authorization: authHeader() },
          });
          if (!rSaldo.ok) return { cliente, contas: [], erroSaldo: `status ${rSaldo.status}` };
          const dadosSaldo = await rSaldo.json();
          const contas = dadosSaldo.results || [];
          return { cliente, contas };
        } catch (e) {
          return { cliente, contas: [], erroSaldo: String(e) };
        }
      }));
      comSaldo.push(...respostasLote);
    }

    // 3) Achata tudo em uma lista simples: uma linha por parcela, já classificada
    const parcelas = [];
    comSaldo.forEach(({ cliente, contas, erroSaldo }) => {
      if (erroSaldo) {
        parcelas.push({
          customerId: cliente.id,
          customerName: cliente.name,
          erroSaldo,
        });
        return;
      }
      contas.forEach((conta) => {
        (conta.paidInstallments || []).forEach((inst) => {
          parcelas.push({
            customerId: cliente.id,
            customerName: cliente.name,
            billReceivableId: conta.billReceivableId,
            documentId: conta.documentId,
            installmentId: inst.installmentId,
            dueDate: inst.dueDate,
            originalValue: inst.originalValue,
            adjustedValue: inst.adjustedValue,
            recebido: true,
            recibos: inst.receipts || [],
          });
        });
        (conta.payableInstallments || []).forEach((inst) => {
          parcelas.push({
            customerId: cliente.id,
            customerName: cliente.name,
            billReceivableId: conta.billReceivableId,
            documentId: conta.documentId,
            installmentId: inst.installmentId,
            dueDate: inst.dueDate,
            originalValue: inst.originalValue,
            adjustedValue: inst.adjustedValue,
            currentBalance: inst.currentBalance,
            recebido: false,
          });
        });
      });
    });

    res.json({
      status: 200,
      ok: true,
      totalClientes: clientesComDocumento.length,
      totalParcelas: parcelas.length,
      resultados: parcelas,
    });
  } catch (err) {
    res.status(502).json({ erro: 'Falha ao montar contas a receber completo', detalhe: String(err) });
  }
});

// ---------- Proxy genérico ----------
// Encaminha qualquer caminho para a API do Sienge, adicionando a autenticação no servidor.
// Exemplo de uso no front-end:
//   fetch('https://sienge-proxymonter.up.railway.app/api/sienge/income?limit=200')
//   fetch('https://sienge-proxymonter.up.railway.app/api/sienge/bills?startDate=2026-01-01&endDate=2026-01-31')
app.get('/api/sienge/*', async (req, res) => {
  if (!credenciaisOk()) {
    return res.status(500).json({ erro: 'Variáveis de ambiente do Sienge não configuradas no Railway.' });
  }
  const caminho = req.params[0];
  const queryString = req.originalUrl.split('?')[1];
  const url = `${SIENGE_BASE_URL}/${caminho}${queryString ? `?${queryString}` : ''}`;

  try {
    const r = await fetch(url, { headers: { Authorization: authHeader(), Accept: 'application/json' } });
    const texto = await r.text();
    res
      .status(r.status)
      .set('Content-Type', r.headers.get('content-type') || 'application/json')
      .send(texto);
  } catch (err) {
    res.status(502).json({ erro: 'Falha ao consultar a API do Sienge', detalhe: String(err) });
  }
});

function safeJson(texto) {
  try { return JSON.parse(texto); } catch { return texto; }
}

const porta = PORT || 3000;
app.listen(porta, () => {
  console.log(`sienge-proxymonter rodando na porta ${porta}`);
  console.log(`Credenciais do Sienge configuradas: ${credenciaisOk()}`);
});
