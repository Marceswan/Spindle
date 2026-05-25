trigger AccountTrigger on Account(before insert, after update) {
    List<Account> records = [SELECT Id, Name FROM Account WHERE Id IN :Trigger.new];
    AccountService svc = new AccountService();
    svc.doThing();
}
