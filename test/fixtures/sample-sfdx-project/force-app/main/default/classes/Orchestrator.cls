public with sharing class Orchestrator {
    public void run() {
        AccountService.cleanup();
        AccountService svc = new AccountService();
        svc.doThing();
    }
}
