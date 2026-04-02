import Map "mo:core/Map";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Int "mo:core/Int";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Debug "mo:core/Debug";
import Result "mo:core/Result";
import Runtime "mo:core/Runtime";
import Array "mo:core/Array";
import Option "mo:core/Option";
import Nat64 "mo:core/Nat64";
import Char "mo:core/Char";
import Float "mo:core/Float";

persistent actor ChainPay {

  // ---- Types ----

  type PaymentMethod = {
    #icp;
    #ckbtc;
  };

  type PaymentStatus = {
    #pending;
    #confirmed;
    #expired;
  };

  type PaymentLink = {
    id : Text;
    creator : Principal;
    title : Text;
    description : Text;
    amount : Nat;
    method : PaymentMethod;
    createdAt : Int;
    expiresAt : ?Int;
    active : Bool;
  };

  type Payment = {
    id : Text;
    linkId : Text;
    payer : Principal;
    amount : Nat;
    method : PaymentMethod;
    status : PaymentStatus;
    txId : ?Nat;
    createdAt : Int;
    confirmedAt : ?Int;
  };

  type PaymentLinkInfo = {
    id : Text;
    creator : Principal;
    title : Text;
    description : Text;
    amount : Nat;
    method : PaymentMethod;
    createdAt : Int;
    expiresAt : ?Int;
    active : Bool;
    totalReceived : Nat;
    paymentCount : Nat;
  };

  type CreateLinkArgs = {
    title : Text;
    description : Text;
    amount : Nat;
    method : PaymentMethod;
    expiresAt : ?Int;
  };

  type ConfirmPaymentArgs = {
    linkId : Text;
    blockIndex : Nat;
  };

  type PriceData = {
    icpUsd : Float;
    btcUsd : Float;
    updatedAt : Int;
  };

  // ICRC-1 types
  type Account = {
    owner : Principal;
    subaccount : ?Blob;
  };

  type TransferArg = {
    from_subaccount : ?Blob;
    to : Account;
    amount : Nat;
    fee : ?Nat;
    memo : ?Blob;
    created_at_time : ?Nat64;
  };

  type TransferResult = {
    #Ok : Nat;
    #Err : TransferError;
  };

  type TransferError = {
    #BadFee : { expected_fee : Nat };
    #BadBurn : { min_burn_amount : Nat };
    #InsufficientFunds : { balance : Nat };
    #TooOld;
    #CreatedInFuture : { ledger_time : Nat64 };
    #Duplicate : { duplicate_of : Nat };
    #TemporarilyUnavailable;
    #GenericError : { error_code : Nat; message : Text };
  };

  // HTTP types for HTTPS outcalls
  type HttpHeader = {
    name : Text;
    value : Text;
  };

  type HttpRequestArgs = {
    url : Text;
    max_response_bytes : ?Nat64;
    headers : [HttpHeader];
    body : ?Blob;
    method : { #get; #head; #post };
    transform : ?{
      function : shared query { context : Blob; response : HttpResponsePayload } -> async HttpResponsePayload;
      context : Blob;
    };
  };

  type HttpResponsePayload = {
    status : Nat;
    headers : [HttpHeader];
    body : Blob;
  };

  // HTTP interface types (for serving pages)
  type HttpRequest = {
    method : Text;
    url : Text;
    headers : [(Text, Text)];
    body : Blob;
  };

  type HttpResponse = {
    status_code : Nat16;
    headers : [(Text, Text)];
    body : Blob;
  };

  // ckBTC minter types
  type GetBtcAddressArgs = {
    owner : ?Principal;
    subaccount : ?Blob;
  };

  // ---- State ----

  var linkCounter : Nat = 0;
  var paymentCounter : Nat = 0;
  let links = Map.empty<Text, PaymentLink>();
  let payments = Map.empty<Text, Payment>();
  let linkPayments = Map.empty<Text, List.List<Text>>();
  let userLinks = Map.empty<Principal, List.List<Text>>();

  transient var cachedPrice : ?PriceData = null;

  // Canister IDs
  let ICP_LEDGER : Principal = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
  let CKBTC_LEDGER : Principal = Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai");
  let CKBTC_MINTER : Principal = Principal.fromText("mqygn-kiaaa-aaaar-qaadq-cai");
  let ANON_PRINCIPAL : Principal = Principal.fromText("2vxsx-fae");

  // ---- Access Control ----

  func requireAuth(caller : Principal) {
    if (Principal.equal(caller, ANON_PRINCIPAL)) {
      Runtime.trap("Anonymous callers not allowed");
    };
  };

  func requireOwner(caller : Principal, linkId : Text) : PaymentLink {
    let ?link = Map.get(links, Text.compare, linkId) else Runtime.trap("Link not found");
    if (not Principal.equal(caller, link.creator)) {
      Runtime.trap("Not the link owner");
    };
    link;
  };

  // ---- Helpers ----

  func generateLinkId() : Text {
    let id = linkCounter;
    linkCounter += 1;
    Nat.toText(id);
  };

  func generatePaymentId() : Text {
    let id = paymentCounter;
    paymentCounter += 1;
    "p" # Nat.toText(id);
  };

  func isLinkExpired(link : PaymentLink) : Bool {
    switch (link.expiresAt) {
      case (?expiry) { Time.now() > expiry };
      case null { false };
    };
  };

  func getLinkTotals(linkId : Text) : (Nat, Nat) {
    let ?paymentIds = Map.get(linkPayments, Text.compare, linkId) else return (0, 0);
    var total : Nat = 0;
    var count : Nat = 0;
    for (pid in List.values(paymentIds)) {
      let ?payment = Map.get(payments, Text.compare, pid) else {
        // skip if payment not found
        total += 0; // no-op to satisfy compiler
        continue;
      };
      switch (payment.status) {
        case (#confirmed) {
          total += payment.amount;
          count += 1;
        };
        case _ {};
      };
    };
    (total, count);
  };

  func toLinkInfo(link : PaymentLink) : PaymentLinkInfo {
    let (totalReceived, paymentCount) = getLinkTotals(link.id);
    {
      id = link.id;
      creator = link.creator;
      title = link.title;
      description = link.description;
      amount = link.amount;
      method = link.method;
      createdAt = link.createdAt;
      expiresAt = link.expiresAt;
      active = link.active and not isLinkExpired(link);
      totalReceived = totalReceived;
      paymentCount = paymentCount;
    };
  };

  func linkSubaccount(linkId : Text) : Blob {
    let bytes = Blob.toArray(Text.encodeUtf8(linkId));
    let padded = Array.tabulate<Nat8>(32, func(i) {
      if (i < bytes.size()) { bytes[i] } else { 0 : Nat8 };
    });
    Blob.fromArray(padded);
  };

  // ---- Public API ----

  public shared (msg) func createLink(args : CreateLinkArgs) : async Text {
    requireAuth(msg.caller);

    if (Text.size(args.title) == 0 or Text.size(args.title) > 100) {
      Runtime.trap("Title must be 1-100 characters");
    };
    if (Text.size(args.description) > 500) {
      Runtime.trap("Description must be <= 500 characters");
    };
    if (args.amount == 0) {
      Runtime.trap("Amount must be greater than 0");
    };

    let id = generateLinkId();
    let link : PaymentLink = {
      id = id;
      creator = msg.caller;
      title = args.title;
      description = args.description;
      amount = args.amount;
      method = args.method;
      createdAt = Time.now();
      expiresAt = args.expiresAt;
      active = true;
    };

    Map.add(links, Text.compare, id, link);

    let existing = Option.get(Map.get(userLinks, Principal.compare, msg.caller), List.empty<Text>());
    List.add(existing, id);
    Map.add(userLinks, Principal.compare, msg.caller, existing);

    id;
  };

  public query func getLink(linkId : Text) : async ?PaymentLinkInfo {
    let ?link = Map.get(links, Text.compare, linkId) else return null;
    ?toLinkInfo(link);
  };

  public query func getPaymentAddress(linkId : Text) : async ?Account {
    let ?_ = Map.get(links, Text.compare, linkId) else return null;
    ?{
      owner = Principal.fromActor(ChainPay);
      subaccount = ?linkSubaccount(linkId);
    };
  };

  public shared (msg) func confirmPayment(args : ConfirmPaymentArgs) : async Result.Result<Text, Text> {
    let ?link = Map.get(links, Text.compare, args.linkId) else return #err("Link not found");

    if (not link.active) return #err("Link is not active");
    if (isLinkExpired(link)) return #err("Link has expired");

    let ledger = switch (link.method) {
      case (#icp) { ICP_LEDGER };
      case (#ckbtc) { CKBTC_LEDGER };
    };

    let paymentAccount : Account = {
      owner = Principal.fromActor(ChainPay);
      subaccount = ?linkSubaccount(args.linkId);
    };

    let balance : Nat = await (actor (Principal.toText(ledger)) : actor {
      icrc1_balance_of : shared query (Account) -> async Nat;
    }).icrc1_balance_of(paymentAccount);

    if (balance < link.amount) {
      return #err("Insufficient payment. Expected " # Nat.toText(link.amount) # " got " # Nat.toText(balance));
    };

    let paymentId = generatePaymentId();
    let payment : Payment = {
      id = paymentId;
      linkId = args.linkId;
      payer = msg.caller;
      amount = balance;
      method = link.method;
      status = #confirmed;
      txId = ?args.blockIndex;
      createdAt = Time.now();
      confirmedAt = ?Time.now();
    };

    Map.add(payments, Text.compare, paymentId, payment);

    let existingPayments = Option.get(Map.get(linkPayments, Text.compare, args.linkId), List.empty<Text>());
    List.add(existingPayments, paymentId);
    Map.add(linkPayments, Text.compare, args.linkId, existingPayments);

    // Transfer funds from subaccount to creator's account
    let fee : Nat = switch (link.method) {
      case (#icp) { 10_000 };
      case (#ckbtc) { 10 };
    };

    if (balance > fee) {
      let transferAmount : Nat = balance - fee;
      let transferResult = await (actor (Principal.toText(ledger)) : actor {
        icrc1_transfer : shared (TransferArg) -> async TransferResult;
      }).icrc1_transfer({
        from_subaccount = ?linkSubaccount(args.linkId);
        to = { owner = link.creator; subaccount = null };
        amount = transferAmount;
        fee = ?fee;
        memo = ?Text.encodeUtf8("chainpay:" # args.linkId);
        created_at_time = null;
      });

      switch (transferResult) {
        case (#Ok(_)) {};
        case (#Err(_)) {
          Debug.print("Transfer to creator failed, funds remain in subaccount");
        };
      };
    };

    #ok(paymentId);
  };

  public func getCkbtcDepositAddress(linkId : Text) : async Text {
    let ?link = Map.get(links, Text.compare, linkId) else Runtime.trap("Link not found");

    switch (link.method) {
      case (#ckbtc) {};
      case _ { Runtime.trap("Link does not accept ckBTC") };
    };

    let minter = actor (Principal.toText(CKBTC_MINTER)) : actor {
      get_btc_address : shared (GetBtcAddressArgs) -> async Text;
    };

    await minter.get_btc_address({
      owner = ?Principal.fromActor(ChainPay);
      subaccount = ?linkSubaccount(linkId);
    });
  };

  public query (msg) func myLinks() : async [PaymentLinkInfo] {
    requireAuth(msg.caller);
    let ?linkIds = Map.get(userLinks, Principal.compare, msg.caller) else return [];
    var result = List.empty<PaymentLinkInfo>();
    for (id in List.values(linkIds)) {
      switch (Map.get(links, Text.compare, id)) {
        case (?link) { List.add(result, toLinkInfo(link)) };
        case null {};
      };
    };
    List.toArray(result);
  };

  public query (msg) func linkPaymentHistory(linkId : Text) : async [Payment] {
    requireAuth(msg.caller);
    let _ = requireOwner(msg.caller, linkId);
    let ?paymentIds = Map.get(linkPayments, Text.compare, linkId) else return [];
    var result = List.empty<Payment>();
    for (pid in List.values(paymentIds)) {
      switch (Map.get(payments, Text.compare, pid)) {
        case (?payment) { List.add(result, payment) };
        case null {};
      };
    };
    List.toArray(result);
  };

  public shared (msg) func deactivateLink(linkId : Text) : async () {
    let link = requireOwner(msg.caller, linkId);
    let updated : PaymentLink = {
      id = link.id;
      creator = link.creator;
      title = link.title;
      description = link.description;
      amount = link.amount;
      method = link.method;
      createdAt = link.createdAt;
      expiresAt = link.expiresAt;
      active = false;
    };
    Map.add(links, Text.compare, linkId, updated);
  };

  public shared (msg) func reactivateLink(linkId : Text) : async () {
    let link = requireOwner(msg.caller, linkId);
    let updated : PaymentLink = {
      id = link.id;
      creator = link.creator;
      title = link.title;
      description = link.description;
      amount = link.amount;
      method = link.method;
      createdAt = link.createdAt;
      expiresAt = link.expiresAt;
      active = true;
    };
    Map.add(links, Text.compare, linkId, updated);
  };

  // Fetch USD prices via HTTPS outcall
  public func getUsdPrices() : async PriceData {
    switch (cachedPrice) {
      case (?price) {
        if (Time.now() - price.updatedAt < 300_000_000_000) {
          return price;
        };
      };
      case null {};
    };

    let ic : actor {
      http_request : shared (HttpRequestArgs) -> async HttpResponsePayload;
    } = actor ("aaaaa-aa");

    let url = "https://api.coingecko.com/api/v3/simple/price?ids=internet-computer,bitcoin&vs_currencies=usd";

    let response = await ic.http_request({
      url = url;
      max_response_bytes = ?2048;
      headers = [
        { name = "User-Agent"; value = "ChainPay/1.0" },
      ];
      body = null;
      method = #get;
      transform = ?{
        function = transform;
        context = Blob.fromArray([]);
      };
    });

    let bodyText = Option.get(Text.decodeUtf8(response.body), "{}");

    let icpPrice = extractPrice(bodyText, "internet-computer");
    let btcPrice = extractPrice(bodyText, "bitcoin");

    let priceData : PriceData = {
      icpUsd = icpPrice;
      btcUsd = btcPrice;
      updatedAt = Time.now();
    };

    cachedPrice := ?priceData;
    priceData;
  };

  public query func transform({
    context : Blob;
    response : HttpResponsePayload;
  }) : async HttpResponsePayload {
    {
      status = response.status;
      headers = [];
      body = response.body;
    };
  };

  func extractPrice(json : Text, key : Text) : Float {
    let searchKey = "\"" # key # "\":{\"usd\":";
    let chars = Text.toArray(json);
    let keyChars = Text.toArray(searchKey);
    let jsonLen = chars.size();
    let keyLen = keyChars.size();

    if (jsonLen < keyLen) return 0.0;

    var i = 0;
    while (i + keyLen <= jsonLen) {
      var matched = true;
      var j = 0;
      while (j < keyLen) {
        if (chars[i + j] != keyChars[j]) {
          matched := false;
          j := keyLen; // break out
        } else {
          j += 1;
        };
      };
      if (matched) {
        var numStr = "";
        var k = i + keyLen;
        while (k < jsonLen) {
          let c = chars[k];
          if (c == '}' or c == ',') {
            k := jsonLen; // break out
          } else {
            numStr #= Text.fromChar(c);
            k += 1;
          };
        };
        return parseFloat(numStr);
      };
      i += 1;
    };
    0.0;
  };

  func parseFloat(s : Text) : Float {
    let chars = Text.toArray(s);
    var intPart : Float = 0;
    var fracPart : Float = 0;
    var fracDiv : Float = 1;
    var afterDot = false;

    for (c in chars.vals()) {
      if (c == '.') {
        afterDot := true;
      } else {
        let digit = Char.toNat32(c);
        if (digit >= 48 and digit <= 57) {
          let d : Float = Float.fromInt(Nat32.toNat(digit - 48));
          if (afterDot) {
            fracDiv *= 10;
            fracPart += d / fracDiv;
          } else {
            intPart := intPart * 10 + d;
          };
        };
      };
    };
    intPart + fracPart;
  };

  // Stats
  public query func stats() : async {
    totalLinks : Nat;
    totalPayments : Nat;
    activeLinks : Nat;
  } {
    var activeCount : Nat = 0;
    for ((_, link) in Map.entries(links)) {
      if (link.active and not isLinkExpired(link)) {
        activeCount += 1;
      };
    };
    {
      totalLinks = Map.size(links);
      totalPayments = Map.size(payments);
      activeLinks = activeCount;
    };
  };

  // HTTP interface - serve payment pages at /pay/{linkId}
  public query func http_request(req : HttpRequest) : async HttpResponse {
    let path = req.url;

    if (Text.startsWith(path, #text "/pay/")) {
      let linkId = stripPrefix(path, "/pay/");
      switch (Map.get(links, Text.compare, linkId)) {
        case (?link) {
          let methodText = switch (link.method) {
            case (#icp) { "ICP" };
            case (#ckbtc) { "ckBTC" };
          };
          let amountText = formatAmount(link.amount, link.method);
          let statusText = if (not link.active) { "inactive" }
            else if (isLinkExpired(link)) { "expired" }
            else { "active" };

          let html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" #
            "<title>Pay " # escapeHtml(link.title) # " - ChainPay</title>" #
            "<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0a0a0a;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh}" #
            ".card{background:#1a1a2e;border-radius:16px;padding:2rem;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.3)}" #
            ".title{font-size:1.5rem;margin-bottom:.5rem}.desc{color:#888;margin-bottom:1.5rem}" #
            ".amount{font-size:2.5rem;font-weight:700;color:#00d4ff;margin-bottom:.25rem}" #
            ".method{color:#888;font-size:.9rem;margin-bottom:1.5rem}" #
            ".status{padding:.25rem .75rem;border-radius:999px;font-size:.8rem;display:inline-block;margin-bottom:1rem}" #
            ".active{background:#00d4ff22;color:#00d4ff}.inactive{background:#ff444422;color:#ff4444}.expired{background:#88888822;color:#888}" #
            ".cta{display:block;width:100%;padding:.75rem;background:#00d4ff;color:#000;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer;text-align:center;text-decoration:none}" #
            ".footer{text-align:center;margin-top:1rem;color:#555;font-size:.8rem}" #
            "</style></head><body><div class=\"card\">" #
            "<div class=\"status " # statusText # "\">" # statusText # "</div>" #
            "<h1 class=\"title\">" # escapeHtml(link.title) # "</h1>" #
            "<p class=\"desc\">" # escapeHtml(link.description) # "</p>" #
            "<div class=\"amount\">" # amountText # "</div>" #
            "<div class=\"method\">Pay with " # methodText # "</div>" #
            (if (statusText == "active") {
              "<a class=\"cta\" href=\"/?pay=" # linkId # "\">Pay Now</a>"
            } else {
              "<div class=\"cta\" style=\"background:#333;color:#666;cursor:default\">Payment Unavailable</div>"
            }) #
            "<div class=\"footer\">Powered by ChainPay on ICP</div>" #
            "</div></body></html>";

          {
            status_code = 200;
            headers = [("Content-Type", "text/html; charset=utf-8")];
            body = Text.encodeUtf8(html);
          };
        };
        case null {
          {
            status_code = 404;
            headers = [("Content-Type", "text/plain")];
            body = Text.encodeUtf8("Payment link not found");
          };
        };
      };
    } else if (path == "/api/stats") {
      var activeCount : Nat = 0;
      for ((_, link) in Map.entries(links)) {
        if (link.active and not isLinkExpired(link)) {
          activeCount += 1;
        };
      };
      let json = "{\"totalLinks\":" # Nat.toText(Map.size(links)) #
        ",\"totalPayments\":" # Nat.toText(Map.size(payments)) #
        ",\"activeLinks\":" # Nat.toText(activeCount) # "}";
      {
        status_code = 200;
        headers = [("Content-Type", "application/json")];
        body = Text.encodeUtf8(json);
      };
    } else {
      {
        status_code = 404;
        headers = [("Content-Type", "text/plain")];
        body = Text.encodeUtf8("Not found");
      };
    };
  };

  func stripPrefix(text : Text, prefix : Text) : Text {
    let textChars = Text.toArray(text);
    let prefixLen = Text.size(prefix);
    let textLen = textChars.size();
    if (textLen <= prefixLen) return "";
    var result = "";
    var i = prefixLen;
    while (i < textLen) {
      let c = textChars[i];
      if (c == '?' or c == '#') return result;
      result #= Text.fromChar(c);
      i += 1;
    };
    result;
  };

  func formatAmount(amount : Nat, method : PaymentMethod) : Text {
    let whole = amount / 100_000_000;
    let frac = amount % 100_000_000;
    let symbol = switch (method) {
      case (#icp) { " ICP" };
      case (#ckbtc) { " ckBTC" };
    };
    if (frac == 0) {
      Nat.toText(whole) # symbol;
    } else {
      Nat.toText(whole) # "." # padFraction(frac) # symbol;
    };
  };

  func padFraction(n : Nat) : Text {
    var s = Nat.toText(n);
    while (Text.size(s) < 8) {
      s := "0" # s;
    };
    let chars = Text.toArray(s);
    var lastNonZero = chars.size();
    while (lastNonZero > 0 and chars[lastNonZero - 1] == '0') {
      lastNonZero -= 1;
    };
    var result = "";
    var i = 0;
    while (i < lastNonZero) {
      result #= Text.fromChar(chars[i]);
      i += 1;
    };
    result;
  };

  func escapeHtml(text : Text) : Text {
    var result = "";
    for (c in text.chars()) {
      if (c == '<') { result #= "&lt;" }
      else if (c == '>') { result #= "&gt;" }
      else if (c == '&') { result #= "&amp;" }
      else if (Char.toNat32(c) == 34) { result #= "&quot;" }
      else { result #= Text.fromChar(c) };
    };
    result;
  };
};
