# NFT Public Mint Sniper

- Source tham khảo từ: [morsyxbt](https://github.com/morsyxbt/nft-public-mint)
- Công cụ CLI mint NFT public qua SeaDrop trên Ethereum, Base và Robinhood Chain.
- Giao dịch được tạo từ dữ liệu on-chain và ký sẵn để gửi đúng thời điểm mở mint.

> Chỉ nên dùng ví phụ và nạp đúng số tiền dự định mint.

## Video hướng dẫn

- Xem hướng dẫn chi tiết: [Video trên X / Twitter](https://x.com/solotop999/status/2089201813983732190?s=20)

## Cài đặt và chạy

Yêu cầu: tự cài đặt [Git](https://git-scm.com/downloads).

Script sẽ tự cài Node.js nếu cần, cài dependency, build, tạo `.env`, thử lấy
OpenSea API key miễn phí rồi chạy chương trình.

### Cài đặt cho Windows
- Mở cmd lên và nhập:

```cmd
git clone https://github.com/solotop999/opensea-nft-public-mint.git && cd opensea-nft-public-mint && install.cmd
```

### Cài đặt cho Linux

```bash
git clone https://github.com/solotop999/opensea-nft-public-mint.git && cd opensea-nft-public-mint && chmod +x install.sh && ./install.sh
```

## Link opensea test mint
- Link để test, hết hạn 08/2027
- Robinhood Chain
- https://opensea.io/collection/tadaaaaaa/overview
  
## Những lần chạy sau

```bash
cd opensea-nft-public-mint
npm start
```

<details>
<summary><strong>Cấu hình RPC riêng</strong></summary>

<br>

Không bắt buộc, nhưng RPC riêng thường nhanh hơn node công khai. Mở `.env` và
điền RPC cho chain cần dùng:

```env
RPC_URL_ETHEREUM=
RPC_URL_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
RPC_URL_ROBINHOOD=
```

Bạn cũng có thể dán URL RPC hoặc Alchemy key trực tiếp khi chương trình hỏi.

### Private key trong .env (tùy chọn)

Dán key vào `.env` để dùng lại ở những lần chạy sau:

```env
PRIVATE_KEY=YOUR_PRIVATE_KEY
# Hoặc nhiều ví:
PRIVATE_KEYS=KEY_1,KEY_2
```

Khi chạy, chọn **Dùng key từ .env** ở menu nguồn private key. Nếu điền cả hai
biến, chương trình nạp cả hai và bỏ qua ví trùng. Chỉ địa chỉ ví được hiển thị.
Bạn vẫn có thể chọn **Dán key ẩn vào CLI** để chỉ giữ key trong RAM.

Key trong `.env` là văn bản thuần; không chia sẻ file này. `.env` đã được bỏ qua
trong Git. Không điền seed phrase vào các biến private key.

### OpenSea API key (chỉ khi dùng slug/link bộ sưu tập)

Installer tự thử tạo và lưu key vào `.env` trong lần chạy đầu. Nếu OpenSea báo
giới hạn tạo key, hãy dùng key hiện có hoặc làm thủ công như dưới đây.

Cách nhanh nhất để lấy key miễn phí:

```bash
curl -X POST https://api.opensea.io/api/v2/auth/keys
```

Sao chép giá trị `api_key` trong kết quả rồi điền vào `.env`:

```env
OPENSEA_API_KEY=KEY_VỪA_SAO_CHÉP
```

Key miễn phí có thời hạn ghi trong trường `expires_at` của kết quả. Khi hết hạn,
tạo key mới và thay giá trị `OPENSEA_API_KEY` trong `.env`. Muốn dùng hạn mức
cao hơn, đăng nhập OpenSea rồi vào **Settings → Developer → Get access → Create key**.

API key chỉ dùng để đổi slug thành địa chỉ contract. Nếu không muốn lấy key,
hãy dán trực tiếp địa chỉ contract `0x...`; quá trình mint không cần OpenSea API.

</details>

<details>
<summary><strong>Cách sử dụng</strong></summary>

<br>

Chương trình lần lượt hỏi:

1. Private key — chọn dán ẩn (chỉ giữ trong RAM) hoặc nạp từ `.env`.
2. Blockchain và số NFT muốn mint trên mỗi ví.
3. Liên kết OpenSea, slug hoặc địa chỉ contract NFT.
4. RPC, phí gas và thời điểm gửi.
5. Xác nhận cuối cùng trước khi phát giao dịch.

Nếu đợt mint chưa mở, chọn **Chờ đợt mint mở** và giữ máy tính cùng terminal
hoạt động. Không có giao dịch nào được gửi trước khi bạn xác nhận `y`.

</details>

<details>
<summary><strong>Lưu ý kỹ thuật và bảo mật</strong></summary>

<br>

- Hỗ trợ public SeaDrop; không hỗ trợ allowlist `mintSigned()`.
- Chi phí gas thực tế là base fee + tip; max fee chỉ là mức trần.
- Chương trình kiểm tra chain ID, số dư, giới hạn mỗi ví và thời gian mở mint.
- Key dán vào CLI không được ghi xuống ổ đĩa. Key tự lưu trong `.env` tồn tại dưới dạng văn bản thuần; RPC chỉ nhận raw transaction đã ký.

## Chain hỗ trợ

| Chain | ID | Explorer |
|---|---:|---|
| Ethereum | 1 | etherscan.io |
| Base | 8453 | basescan.org |
| Robinhood Chain | 4663 | robinhoodchain.blockscout.com |

</details>

## Giấy phép

MIT
