# Espelho SMA + Firebase

Este pacote contém:
- `firebase-db.js`: módulo de acesso ao Cloud Firestore, compatível com GitHub Pages.
- `firestore.rules`: regras que exigem login.

## 1. Configurar o Firebase

1. Acesse o projeto `bi-gns` no Firebase Console.
2. Em **Build → Authentication → Sign-in method**, habilite **E-mail/senha**.
3. Em **Authentication → Users**, crie uma conta para cada pessoa autorizada.
4. Em **Build → Firestore Database**, crie o banco de dados.
5. Na aba **Rules**, publique o conteúdo de `firestore.rules`.
6. Não habilite cadastro público de usuários. Crie as contas manualmente para evitar que qualquer pessoa se registre e acesse os dados.

A configuração web do Firebase (incluindo `apiKey`) identifica o projeto; ela não substitui as regras de segurança. As regras deste pacote protegem o banco exigindo autenticação.

## 2. Colocar no GitHub

Coloque `firebase-db.js` na mesma pasta do HTML do Espelho SMA. Como o Espelho é HTML estático, não precisa rodar `npm install firebase`: o módulo importa o SDK oficial pelo CDN.

## 3. Como usar no código

No HTML, adicione um script de módulo (ou incorpore estas chamadas ao fluxo de salvamento existente):

```html
<script type="module">
  import "./firebase-db.js";

  // Exemplo de login:
  // await window.FirebaseDB.login("seu-email@empresa.com", "sua-senha");

  // Depois do login, para salvar o objeto completo do Espelho:
  // await window.FirebaseDB.saveEspelho(window.espelhoRaw);

  // Para recuperar os dados:
  // const salvo = await window.FirebaseDB.loadEspelho();
  // if (salvo) console.log(salvo.data, salvo.savedAt);
</script>
```

**Importante:** esse módulo fornece a conexão e as funções de banco; sozinho ele não altera automaticamente o Espelho atual. O HTML precisa chamar `login`, `saveEspelho` e `loadEspelho` no fluxo da interface. No código atual do Espelho, o objeto principal chama-se `raw` e está dentro do script clássico, portanto é necessário fazer a ligação explícita com as funções no próprio HTML. Não exponha a senha no código nem a grave no GitHub.

## 4. Estrutura de dados

O módulo grava cada versão em `espelhoSMA/versions/items/{versao}` (e os pedaços em `.../chunks/{id}`) e atualiza `espelhoSMA/current` somente depois que todos os pedaços da nova versão foram gravados. Os dados grandes são divididos em documentos menores para contornar o limite de 1 MiB por documento do Firestore.

As versões antigas permanecem no banco. Depois de validar o funcionamento, pode-se adicionar uma rotina de limpeza das versões antigas.

## 5. Teste inicial

Depois de configurar o banco e a conta:
1. Abra o Espelho hospedado no GitHub Pages (HTTPS).
2. Faça login usando `FirebaseDB.login(email, senha)`.
3. Chame `FirebaseDB.saveEspelho(objetoRaw)`.
4. Recarregue e teste `FirebaseDB.loadEspelho()`.

Se houver erro de permissão, confira se o Firestore foi criado e se as regras foram publicadas.
