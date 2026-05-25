public with sharing class AccountService extends BaseService implements Cleanable {
    public class AccountWrapper {
        public Account record { get; set; }
        public AccountWrapper(Account rec) {
            this.record = rec;
        }
    }

    public static void cleanup() {
        purge();
    }

    private static void purge() {
        List<Account> stale = [SELECT Id, Name FROM Account WHERE IsDeleted = FALSE];
        System.debug('purging ' + stale.size() + ' accounts');
    }

    public override void doThing() {
        System.debug('AccountService.doThing');
    }
}
