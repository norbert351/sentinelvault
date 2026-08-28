// Replay protection test: reuse the SAME payment-signature twice.
// 1st replay should 200 (or have passed), 2nd must be 402 payment_already_used.
import { JsonRpcProvider, Contract, Wallet } from 'ethers';
const PK = process.env.SENTINEL_PK;
const API = process.env.SV_API || 'http://localhost:8098';
const RPC = process.env.SV_RPC || 'https://base-sepolia.publicnode.com';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const provider = new JsonRpcProvider(RPC);
const wallet = new Wallet(PK, provider);
const DOMAIN = (c)=>({name:'x402',version:'2',chainId:Number(c.chainId)});
const TYPES={Payment:[{name:'scheme',type:'string'},{name:'network',type:'string'},{name:'chainId',type:'uint256'},{name:'asset',type:'address'},{name:'amount',type:'string'},{name:'payTo',type:'address'},{name:'maxTimeoutSeconds',type:'uint256'},{name:'description',type:'string'},{name:'extra',type:'string'}]};
const msgOf=(a)=>({scheme:a.scheme,network:`eip155:${a.chainId}`,chainId:BigInt(a.chainId),asset:a.asset,amount:String(a.amount),payTo:a.payTo,maxTimeoutSeconds:BigInt(a.maxTimeoutSeconds),description:a.description||'',extra:typeof a.extra==='string'?a.extra:JSON.stringify(a.extra||{})});

async function payOnce(q){
  const a=q.challenge.accepts[0];
  const payer=(await wallet.getAddress()).toLowerCase();
  const usdc=new Contract(USDC,['function transfer(address,uint256) returns (bool)'],wallet);
  const tx=await usdc.transfer(a.payTo,BigInt(a.amount)); await tx.wait();
  const sig=await wallet.signTypedData(DOMAIN(a),TYPES,msgOf(a));
  return btoa(JSON.stringify({accepted:a,signature:sig,payer}));
}
async function replay(hdr){
  const res=await fetch(API+'/screen',{method:'POST',headers:{'Content-Type':'application/json','PAYMENT-SIGNATURE':hdr},body:JSON.stringify({target:'0x28C6c06298d514Db089934071355E5743bf21d60',kind:'token'})});
  const d=await res.json();
  return {status:res.status, err:d.error||d.detail||null};
}
const q=await(await fetch(API+'/screen/quote')).json();
const hdr=await payOnce(q);
const first=await replay(hdr);
const second=await replay(hdr);
console.log('1st replay:', first.status, '(expect 200)');
console.log('2nd replay:', second.status, second.err, '(expect 402 payment_already_used or fresh 402)');
process.exit(0);