// v0.8 DML-write fixture. Exercises:
//   - Member-expression assignment: c.Email__c = ...
//   - Mixed read + write: SELECT followed by DML write
//   - A helper method that only writes (no SOQL) — relies on parameter-type disambiguation
//     in pass2 to associate `Email__c` with `Customer__c` rather than failing.
public with sharing class CustomerWriter {
    public static void promoteToGold(Id customerId) {
        Customer__c c = [SELECT Id, Email__c, Tier__c FROM Customer__c WHERE Id = :customerId];
        c.Tier__c = 'Gold';
        update c;
    }

    public static void setEmail(Customer__c rec, String newEmail) {
        rec.Email__c = newEmail;
    }

    // v0.9: constructor-arg field writes. Each name=value pair inside the constructor call
    // is detected and resolved directly to the Customer__c.Email__c / Customer__c.Tier__c
    // Field nodes (no short-name fallback needed because the SObject type is known from
    // the createdName).
    public static Customer__c makeGoldCustomer(String email) {
        return new Customer__c(Email__c = email, Tier__c = 'Gold');
    }

    // List-literal initializer with inline constructors — should also be detected because
    // the walker recurses into the nested CreatorContext.
    public static List<Customer__c> seedBatch() {
        return new List<Customer__c>{
            new Customer__c(Email__c = 'a@example.com', Tier__c = 'Bronze'),
            new Customer__c(Email__c = 'b@example.com', Tier__c = 'Silver')
        };
    }
}
