class JavaClient {
  void users() { new Request.Builder().url("https://api.example.test/users").get().build(); }
}
