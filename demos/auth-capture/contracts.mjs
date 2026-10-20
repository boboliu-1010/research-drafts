import { parseAbi } from 'viem';
export const ADDRESSES = {
  escrow: '0xf96815976523E00e65Be8f34cA5e64b4f41EB19c',
  erc3009: '0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88',
  permit2Collector: '0xD69831Aed5bfe262067ec4c751f4F830EcdD446e',
  refundCollector: '0x7a03443724d14798c4AB4622F1DAAcA761Fea486',
  usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};
export const CHAIN_ID = 84532;
export const FORK_BLOCK = 48366193n;
export const SOURCE_COMMIT = 'b748fdd7a830a655a19a530edcf2a94b9dc7d25f';
const info = '(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)';
export const escrowAbi = parseAbi([
  `function getHash(${info} paymentInfo) view returns (bytes32)`,
  'function getTokenStore(address operator) view returns (address)',
  'function tokenStoreImplementation() view returns (address)',
  'function PAYMENT_INFO_TYPEHASH() view returns (bytes32)',
  'function paymentState(bytes32 hash) view returns (bool hasCollectedPayment,uint120 capturableAmount,uint120 refundableAmount)',
  `function authorize(${info} paymentInfo,uint256 amount,address collector,bytes data)`,
  `function capture(${info} paymentInfo,uint256 amount,uint256 feeAmount,address feeReceiver)`,
  `function charge(${info} paymentInfo,uint256 amount,address collector,bytes data,uint256 feeAmount,address feeReceiver)`,
  `function void(${info} paymentInfo)`, `function reclaim(${info} paymentInfo)`,
  `function refund(${info} paymentInfo,uint256 amount,address collector,bytes data)`,
  `event PaymentAuthorized(bytes32 indexed paymentInfoHash,${info} paymentInfo,uint256 amount,address tokenCollector)`,
  `event PaymentCharged(bytes32 indexed paymentInfoHash,${info} paymentInfo,uint256 amount,address tokenCollector,uint256 feeAmount,address feeReceiver)`,
  'event PaymentCaptured(bytes32 indexed paymentInfoHash,uint256 amount,uint256 feeAmount,address feeReceiver)',
  'event PaymentVoided(bytes32 indexed paymentInfoHash,uint256 amount)',
  'event PaymentReclaimed(bytes32 indexed paymentInfoHash,uint256 amount)',
  'event PaymentRefunded(bytes32 indexed paymentInfoHash,uint256 amount,address tokenCollector)',
  'event TokenStoreCreated(address indexed operator,address tokenStore)',
  'error InvalidSender(address sender,address expected)', 'error ZeroAmount()',
  'error PaymentAlreadyCollected(bytes32 paymentInfoHash)',
  'error InsufficientAuthorization(bytes32 paymentInfoHash,uint256 authorizedAmount,uint256 requestedAmount)',
  'error FeeAmountOutOfRange(uint256 feeAmount,uint256 minFee,uint256 maxFee)',
  'error ZeroAuthorization(bytes32 paymentInfoHash)',
  'error BeforeAuthorizationExpiry(uint48 timestamp,uint48 expiry)',
  'error AfterAuthorizationExpiry(uint48 timestamp,uint48 expiry)',
  'error RefundExceedsCapture(uint256 refund,uint256 captured)', 'error TokenCollectionFailed()',
]);
export const tokenAbi = parseAbi([
  'function name() view returns (string)', 'function version() view returns (string)',
  'function decimals() view returns (uint8)', 'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
  'function masterMinter() view returns (address)', 'function blacklister() view returns (address)',
  'function configureMinter(address minter,uint256 amount) returns (bool)',
  'function mint(address to,uint256 amount) returns (bool)',
  'function blacklist(address account)', 'function unBlacklist(address account)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
export const collectorAbi = parseAbi([
  'function authCaptureEscrow() view returns (address)', 'function collectorType() view returns (uint8)',
  'function multicall3() view returns (address)', 'function permit2() view returns (address)',
]);
export const receiveTypes = { ReceiveWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] };
export const json = value => JSON.stringify(value, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2);
